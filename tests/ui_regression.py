import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass


def read_two_lane_geometry(page, task_ids):
    return page.evaluate(
        """
        taskIds => taskIds.map(taskId => {
          const row = document.querySelector('#gt tbody tr[data-task-id="' + taskId + '"]');
          const rowRect = row.getBoundingClientRect();
          const bars = Array.from(row.querySelectorAll('.bar')).map(bar => {
            const rect = bar.getBoundingClientRect();
            const text = bar.querySelector('.bt');
            const textRect = text.getBoundingClientRect();
            const phaseLabel = bar.querySelector('.bt-phase');
            const phaseRect = phaseLabel ? phaseLabel.getBoundingClientRect() : null;
            return {
              phase:Number(bar.dataset.phase),
              lane:bar.dataset.lane,
              left:rect.left,
              right:rect.right,
              top:rect.top,
              bottom:rect.bottom,
              centerY:(rect.top + rect.bottom) / 2,
              relativeCenterY:(rect.top + rect.bottom) / 2 - rowRect.top,
              bounded:rect.top >= rowRect.top - .5 && rect.bottom <= rowRect.bottom + .5,
              textBounded:textRect.left >= rect.left - .5 && textRect.right <= rect.right + .5,
              textClipped:getComputedStyle(text).overflowX === 'hidden',
              phaseVisible:!phaseRect || (phaseRect.width > 0 && phaseRect.left >= rect.left - .5 && phaseRect.right <= rect.right + .5),
              hasTitle:!!bar.getAttribute('title')
            };
          });
          let overlaps = 0;
          for (let i = 0; i < bars.length; i++) {
            for (let j = i + 1; j < bars.length; j++) {
              const xOverlap = Math.min(bars[i].right, bars[j].right) - Math.max(bars[i].left, bars[j].left);
              const yOverlap = Math.min(bars[i].bottom, bars[j].bottom) - Math.max(bars[i].top, bars[j].top);
              if (xOverlap > .5 && yOverlap > .5) overlaps++;
            }
          }
          return {
            taskId,
            height:Math.round(rowRect.height),
            rowCenter:rowRect.height / 2,
            bars,
            overlaps
          };
        })
        """,
        task_ids,
    )


def assert_two_lane_geometry(metrics):
    for row in metrics:
        assert row["height"] == (38 if len(row["bars"]) == 1 else 56), row
        assert row["overlaps"] == 0, row
        assert all(bar["bounded"] for bar in row["bars"]), row
        assert all(bar["textBounded"] and bar["textClipped"] for bar in row["bars"]), row
        assert all(bar["phaseVisible"] and bar["hasTitle"] for bar in row["bars"]), row
        if len(row["bars"]) == 1:
            assert row["bars"][0]["lane"] == "single", row
            assert abs(row["bars"][0]["relativeCenterY"] - row["rowCenter"]) <= 1, row
            continue
        upper = [bar["relativeCenterY"] for bar in row["bars"] if bar["phase"] % 2 == 1]
        lower = [bar["relativeCenterY"] for bar in row["bars"] if bar["phase"] % 2 == 0]
        assert {bar["lane"] for bar in row["bars"] if bar["phase"] % 2 == 1} == {"upper"}, row
        assert {bar["lane"] for bar in row["bars"] if bar["phase"] % 2 == 0} == {"lower"}, row
        assert max(upper) - min(upper) <= 1, row
        assert max(lower) - min(lower) <= 1, row
        assert min(lower) - max(upper) >= 25, row


def exercise_phase_pointer_edits(page, task_id):
    page.evaluate(
        """
        taskId => {
          const task = S.tasks.find(item => item.id === taskId);
          for (let phaseIndex = 1; phaseIndex <= 5; phaseIndex++) {
            const sd = addD('2026-08-06', (phaseIndex - 1) * 4);
            ScheduleCore.updateTaskPhase(task, phaseIndex, {
              sd, ed:addD(sd, 1), mode:'auto'
            });
          }
          sync(); rEdit(); rChart();
        }
        """,
        task_id,
    )
    operations = 0
    for phase_index in range(1, 6):
        selector = f'.bar[data-task-id="{task_id}"][data-phase="{phase_index}"]'
        for mode in ("move", "left", "right"):
            before = page.evaluate(
                """
                taskId => ScheduleCore.getTaskPhases(
                  S.tasks.find(item => item.id === taskId), {activeOnly:true}
                )
                """,
                task_id,
            )
            bar = page.locator(selector)
            bar.scroll_into_view_if_needed()
            box = bar.bounding_box()
            assert box is not None
            if mode == "left":
                start_x = box["x"] + 2
            elif mode == "right":
                start_x = box["x"] + box["width"] - 2
            else:
                start_x = box["x"] + box["width"] / 2
            y = box["y"] + box["height"] / 2
            page.mouse.move(start_x, y)
            page.mouse.down()
            page.mouse.move(start_x + 31, y, steps=2)
            page.mouse.up()
            after = page.evaluate(
                """
                taskId => ScheduleCore.getTaskPhases(
                  S.tasks.find(item => item.id === taskId), {activeOnly:true}
                )
                """,
                task_id,
            )
            assert all(
                index == phase_index - 1 or phase == before[index]
                for index, phase in enumerate(after)
            ), {"phase": phase_index, "mode": mode, "before": before, "after": after}
            target_before = before[phase_index - 1]
            target_after = after[phase_index - 1]
            if mode == "move":
                assert target_after["sd"] > target_before["sd"]
                assert target_after["ed"] > target_before["ed"]
            elif mode == "left":
                assert target_after["sd"] > target_before["sd"]
                assert target_after["ed"] == target_before["ed"]
            else:
                assert target_after["sd"] == target_before["sd"]
                assert target_after["ed"] > target_before["ed"]
            assert target_after["mode"] == "manual"
            page.evaluate("doUndo()")
            restored = page.evaluate(
                """
                taskId => ScheduleCore.getTaskPhases(
                  S.tasks.find(item => item.id === taskId), {activeOnly:true}
                )
                """,
                task_id,
            )
            assert restored == before, {"phase": phase_index, "mode": mode, "restored": restored}
            operations += 1
    return operations


def run_chart_task_management(
    browser,
    origin,
    route_request,
    screenshot_dir,
    console_errors,
    page_errors,
    request_failures,
):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    context.add_init_script(
        """
        window.__ISM_TEST_MODE__ = true;
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('_deviceName', 'chart-task-qa');
        localStorage.setItem('_gcalEnabled', '0');
        """
    )
    context.route("**/*", route_request)
    page = context.new_page()
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}"))
    page.goto(origin + "/", wait_until="domcontentloaded")
    page.evaluate(
        """
        () => {
          const state = defaultState();
          state.pn = 'Chart Manager QA';
          state.sd = '2026-08-05';
          state.ed = '2026-09-01';
          state.tasks.forEach((task, index) => {
            task.on = true;
            task.sd = addD(state.sd, Math.min(index, 10));
            task.ed = addD(task.sd, 2);
            task.scheduleMode = 'auto';
          });
          state.tasks.slice(1, 5).forEach((task, taskIndex) => {
            const phaseCount = taskIndex + 2;
            while (ScheduleCore.getTaskPhaseCount(task) < phaseCount) {
              ScheduleCore.addTaskPhase(task, {name:task.name, desc:'', mode:'manual'});
            }
            for (let phaseIndex = 1; phaseIndex <= phaseCount; phaseIndex++) {
              const day = addD(state.sd, (phaseIndex - 1) * 3);
              ScheduleCore.updateTaskPhase(task, phaseIndex, {
                sd:day,
                ed:day,
                name:'좁은 막대 ' + phaseIndex + '차',
                desc:'이웃 막대 침범 방지 확인',
                mode:'manual'
              });
            }
          });
          const record = {
            pn:state.pn, sd:state.sd, ed:state.ed, confirmed:false,
            savedAt:'2026-08-07 09:00', snap:JSON.stringify(state)
          };
          localStorage.setItem('cs_recent', JSON.stringify([record]));
          localStorage.setItem('cs_last', state.pn);
          S = ScheduleCore.normalizeScheduleState(state);
          _origPn = state.pn;
          _cancelPn = null;
          _open = null;
          IS_RO = false;
          _cloudEditing = null;
          _cloudView = null;
          _cloudSites = [];
          _cloudInventoryReady = true;
          _fbReady = false;
          _db = null;
          calInit(); sync(); rEdit(); rChips(); sw('c'); rChart();
        }
        """
    )

    initial_two_lane = read_two_lane_geometry(page, [1, 2, 3, 4, 5])
    assert [len(row["bars"]) for row in initial_two_lane] == [1, 2, 3, 4, 5]
    assert_two_lane_geometry(initial_two_lane)
    if screenshot_dir:
        page.locator("#pc").screenshot(path=str(screenshot_dir / "chart-two-lane-desktop.png"))

    initial_on = page.evaluate("S.tasks.find(task => task.id === 1).on")
    page.locator('.chart-task-name[data-task-id="1"]').click()
    page.locator("#chartTaskOv").wait_for(state="visible")
    assert page.evaluate("S.tasks.find(task => task.id === 1).on") == initial_on
    assert page.locator('#chartTaskBody .delete-task-btn[data-task-id="1"]').count() == 0
    assert page.locator("#chartTaskActions .chart-task-done").is_visible()
    assert page.locator('#chartTaskActions .remove-phase-btn[data-task-id="1"]').count() == 0
    desktop_bounds = page.evaluate(
        """
        () => {
          const rect = document.querySelector('#chartTaskOv .chart-task-sheet').getBoundingClientRect();
          return {left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom,
                  width:innerWidth, height:innerHeight};
        }
        """
    )
    assert desktop_bounds["left"] >= 0 and desktop_bounds["top"] >= 0
    assert desktop_bounds["right"] <= desktop_bounds["width"]
    assert desktop_bounds["bottom"] <= desktop_bounds["height"]

    for expected_count in range(2, 6):
        page.locator('#chartTaskActions .add-phase-btn[data-task-id="1"]').click()
        assert page.evaluate("ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))") == expected_count
        if expected_count == 2:
            footer_order = page.evaluate(
                """
                () => {
                  const remove = document.querySelector('#chartTaskActions .remove-phase-btn').getBoundingClientRect();
                  const add = document.querySelector('#chartTaskActions .add-phase-btn').getBoundingClientRect();
                  return {
                    removeLeft:remove.left,
                    addLeft:add.left,
                    removeText:document.querySelector('#chartTaskActions .remove-phase-btn').textContent.trim(),
                    addText:document.querySelector('#chartTaskActions .add-phase-btn').textContent.trim()
                  };
                }
                """
            )
            assert footer_order["removeLeft"] < footer_order["addLeft"]
            assert footer_order["removeText"] == "- 2차 제거"
            assert footer_order["addText"] == "+ 3차 추가"
    assert page.locator('#chartTaskActions .add-phase-btn[data-task-id="1"]').count() == 0
    assert page.locator('#chartTaskActions .remove-phase-btn[data-task-id="1"]').inner_text() == "- 5차 제거"
    sticky_footer = page.evaluate(
        """
        () => {
          const body = document.getElementById('chartTaskBody');
          const footer = document.getElementById('chartTaskActions');
          const done = footer.querySelector('.chart-task-done');
          const phaseActions = footer.querySelector('.chart-task-phase-actions');
          const before = footer.getBoundingClientRect();
          body.scrollTop = body.scrollHeight;
          const after = footer.getBoundingClientRect();
          const doneRect = done.getBoundingClientRect();
          const actionRect = phaseActions.getBoundingClientRect();
          const sheetRect = footer.closest('.chart-task-sheet').getBoundingClientRect();
          return {
            scrollTop:body.scrollTop,
            stationary:Math.abs(before.top - after.top),
            position:getComputedStyle(footer).position,
            doneVisible:doneRect.top >= sheetRect.top && doneRect.bottom <= sheetRect.bottom + .5,
            doneFullWidth:Math.abs(doneRect.width - actionRect.width) <= 1,
            doneSecondRow:doneRect.top >= actionRect.bottom + 7
          };
        }
        """
    )
    assert sticky_footer["scrollTop"] > 0
    assert sticky_footer["stationary"] <= 1
    assert sticky_footer["position"] == "sticky"
    assert sticky_footer["doneVisible"] is True
    assert sticky_footer["doneFullWidth"] is True
    assert sticky_footer["doneSecondRow"] is True

    phase_snapshot = page.evaluate(
        "ScheduleCore.getTaskPhases(S.tasks.find(task => task.id === 1), {activeOnly:true})"
    )
    for expected_count in range(4, 0, -1):
        page.locator('#chartTaskActions .remove-phase-btn[data-task-id="1"]').click()
        assert page.evaluate("ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))") == expected_count
    assert page.locator('#chartTaskActions .remove-phase-btn[data-task-id="1"]').count() == 0
    page.evaluate("doUndo()")
    assert page.evaluate("ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))") == 2
    page.evaluate("doRedo()")
    assert page.evaluate("ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))") == 1
    for _ in range(4):
        page.evaluate("doUndo()")
    assert page.evaluate("ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))") == 5

    phase_four_name = page.locator('#chartTaskBody .chart-manager-name[data-task-id="1"][data-phase="4"]')
    phase_four_name.fill("차트 4차")
    phase_four_name.press("Tab")
    phase_four_desc = page.locator('#chartTaskBody .chart-manager-desc[data-task-id="1"][data-phase="4"]')
    phase_four_desc.fill("차트에서 독립 수정")
    phase_four_desc.press("Tab")
    page.locator('#chartTaskBody .chart-task-date[data-task-id="1"][data-phase="4"]').click()
    page.locator('#tcalOv .tcal-dn[data-ds="2026-08-19"]').click()
    page.locator('#tcalOv .tcal-dn[data-ds="2026-08-20"]').click()
    page.locator("#chartTaskOv").wait_for(state="visible")
    independent_phase_result = page.evaluate(
        """
        before => {
          const phases = ScheduleCore.getTaskPhases(S.tasks.find(task => task.id === 1), {activeOnly:true});
          return {
            fourth:phases[3],
            othersUnchanged:phases.every((phase, index) => index === 3 || JSON.stringify(phase) === JSON.stringify(before[index]))
          };
        }
        """,
        phase_snapshot,
    )
    assert independent_phase_result["fourth"]["name"] == "차트 4차"
    assert independent_phase_result["fourth"]["desc"] == "차트에서 독립 수정"
    assert independent_phase_result["fourth"]["sd"] == "2026-08-19"
    assert independent_phase_result["fourth"]["ed"] == "2026-08-20"
    assert independent_phase_result["fourth"]["mode"] == "manual"
    assert independent_phase_result["othersUnchanged"] is True
    if screenshot_dir:
        page.screenshot(path=str(screenshot_dir / "chart-phase-desktop.png"), full_page=False)
    final_desc = page.locator('#chartTaskBody .chart-manager-desc[data-task-id="1"][data-phase="4"]')
    final_desc.fill("완료 버튼 즉시 저장")
    page.locator("#chartTaskActions .chart-task-done").click()
    page.locator("#chartTaskOv").wait_for(state="hidden")
    immediate_persist = page.evaluate(
        """
        () => {
          const record = JSON.parse(localStorage.getItem('cs_recent')).find(item => item.pn === 'Chart Manager QA');
          const restored = ScheduleCore.normalizeScheduleState(JSON.parse(record.snap));
          return ScheduleCore.getTaskPhase(restored.tasks.find(task => task.id === 1), 4).desc;
        }
        """
    )
    assert immediate_persist == "완료 버튼 즉시 저장"
    pointer_edit_operations = exercise_phase_pointer_edits(page, 1)
    assert pointer_edit_operations == 15
    assert_two_lane_geometry(read_two_lane_geometry(page, [1, 2, 3, 4, 5]))

    page.locator("#chartAddTask").click()
    page.locator("#chartCustomName").fill("차트 사용자 공종 A")
    page.locator("#chartCustomDesc").fill("차트 생성")
    page.locator("#chartCustomDates").click()
    page.locator('#tcalOv .tcal-dn[data-ds="2026-08-24"]').click()
    page.locator('#tcalOv .tcal-dn[data-ds="2026-08-25"]').click()
    page.locator("#chartCustomOv").wait_for(state="visible")
    page.locator("#chartCustomSave").click()
    page.locator("#chartTaskOv").wait_for(state="visible")
    custom_a = page.evaluate("S.tasks.find(task => task.name === '차트 사용자 공종 A').id")
    for expected_count in range(2, 6):
        page.locator(f'#chartTaskActions .add-phase-btn[data-task-id="{custom_a}"]').click()
        assert page.evaluate(
            f"ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === {custom_a}))"
        ) == expected_count
    if screenshot_dir:
        page.screenshot(path=str(screenshot_dir / "chart-custom-desktop.png"), full_page=False)
    page.locator("#chartTaskOv .chart-task-close").click()

    page.locator("#chartAddTask").click()
    page.locator("#chartCustomName").fill("차트 사용자 공종 B")
    page.locator("#chartCustomSave").click()
    custom_b = page.evaluate("S.tasks.find(task => task.name === '차트 사용자 공종 B').id")
    assert page.locator(f'#chartTaskBody .chart-task-danger-zone .delete-task-btn[data-task-id="{custom_b}"]').count() == 1
    assert page.locator(f'#chartTaskActions .delete-task-btn[data-task-id="{custom_b}"]').count() == 0
    page.locator(f'#chartTaskBody .delete-task-btn[data-task-id="{custom_b}"]').click()
    page.locator("#igConfirmOk").click()
    assert page.evaluate(f"S.tasks.some(task => task.id === {custom_b})") is False
    page.evaluate("doUndo()")
    order_after_undo = page.evaluate(
        "Array.from(document.querySelectorAll('#gt tbody tr')).map(row => Number(row.dataset.taskId))"
    )
    tail = [13, custom_a, custom_b, 12, 14]
    assert [task_id for task_id in order_after_undo if task_id in tail] == tail
    assert page.evaluate(f"S.tasks.find(task => task.id === {custom_a}).id") == custom_a
    assert page.evaluate(f"S.tasks.find(task => task.id === {custom_b}).id") == custom_b
    page.evaluate("doRedo()")
    assert page.evaluate(f"S.tasks.some(task => task.id === {custom_b})") is False

    page.locator("#tabs > #te").click()
    shared_state = page.evaluate(
        f"""
        () => {{
          const editOrder = Array.from(document.querySelectorAll('#tl .tc')).map(card => Number(card.dataset.taskId));
          const vendorOrder = Array.from(document.querySelectorAll('#ctorMgrList .ctor-mgr-item')).map(item => Number(item.dataset.taskId));
          const cloud = JSON.parse(JSON.stringify(S));
          _cloudSites = [cloud];
          return {{
            editOrder,
            vendorOrder,
            integratedOrder:igTaskOrder(),
            autoOrder:ScheduleCore.orderedTaskIds([S], [1,2,3,4,5,6,7,8,9,10,11,13,12,14]),
            phaseCount:ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === {custom_a})),
            stableId:S.tasks.find(task => task.name === '차트 사용자 공종 A').id
          }};
        }}
        """
    )
    expected_tail = [13, custom_a, 12, 14]
    for key in ("editOrder", "vendorOrder", "integratedOrder", "autoOrder"):
        assert [task_id for task_id in shared_state[key] if task_id in expected_tail] == expected_tail
    assert shared_state["phaseCount"] == 5
    assert shared_state["stableId"] == custom_a

    page.emulate_media(media="print")
    assert page.locator("#chartAddTask").is_visible() is False
    assert page.evaluate("getComputedStyle(document.querySelector('#chartAddTask').closest('.no-print')).display") == "none"
    assert page.locator("#chartTaskOv").is_visible() is False
    page.emulate_media(media="screen")

    page.wait_for_timeout(950)
    persisted = page.evaluate(
        f"""
        () => {{
          const record = JSON.parse(localStorage.getItem('cs_recent')).find(item => item.pn === 'Chart Manager QA');
          const restored = ScheduleCore.normalizeScheduleState(JSON.parse(record.snap));
          const custom = restored.tasks.find(task => task.id === {custom_a});
          return {{
            phaseCount:ScheduleCore.getTaskPhaseCount(restored.tasks.find(task => task.id === 1)),
            customPhaseCount:ScheduleCore.getTaskPhaseCount(custom),
            customOrder:ScheduleCore.orderedTasks(restored.tasks).map(task => task.id),
            stableId:custom.id
          }};
        }}
        """
    )
    assert persisted["phaseCount"] == 5
    assert persisted["customPhaseCount"] == 5
    assert persisted["stableId"] == custom_a
    assert [task_id for task_id in persisted["customOrder"] if task_id in expected_tail] == expected_tail

    page.locator("#tabs > #tc2").click()
    page.evaluate("IS_RO = true; rChart();")
    assert page.locator("#chartAddTask").is_disabled()
    readonly_before = page.evaluate("JSON.stringify(S)")
    page.locator('.chart-task-name[data-task-id="1"]').click()
    assert page.locator('#chartTaskBody input:not([disabled])').count() == 0
    assert page.locator('#chartTaskBody .chart-task-date:not([disabled])').count() == 0
    assert page.locator('#chartTaskActions .chart-task-action:not([disabled])').count() == 0
    assert page.locator('#chartTaskActions .chart-task-done:not([disabled])').count() == 1
    page.evaluate(
        f"""
        () => {{
          chartToggleTask(1);
          addTaskPhase(1);
          removeTaskPhase(1);
          chartUpdateTaskPhase(1, 1, 'name', '차단 실패');
          deleteCustomTaskConfirm({custom_a});
          openChartCustomTask();
        }}
        """
    )
    assert page.evaluate("JSON.stringify(S)") == readonly_before
    page.locator("#chartTaskActions .chart-task-done").click()
    page.locator("#chartTaskOv").wait_for(state="hidden")
    assert page.evaluate("JSON.stringify(S)") == readonly_before
    page.locator('.chart-task-name[data-task-id="1"]').click()
    page.locator("#chartTaskOv .chart-task-close").click()
    page.locator("#chartTaskOv").wait_for(state="hidden")
    assert page.evaluate("JSON.stringify(S)") == readonly_before
    page.evaluate("IS_RO = false; rChart();")
    mobile_state = page.evaluate("JSON.parse(JSON.stringify(S))")

    mobile_context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    mobile_context.add_init_script(
        """
        window.__ISM_TEST_MODE__ = true;
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('_deviceName', 'chart-task-mobile-qa');
        localStorage.setItem('_gcalEnabled', '0');
        """
    )
    mobile_context.route("**/*", route_request)
    mobile_page = mobile_context.new_page()
    mobile_page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    mobile_page.on("pageerror", lambda error: page_errors.append(str(error)))
    mobile_page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}"))
    mobile_page.goto(origin + "/", wait_until="domcontentloaded")
    mobile_page.evaluate(
        """
        state => {
          S = ScheduleCore.normalizeScheduleState(state);
          _origPn = state.pn;
          IS_RO = false;
          _cloudEditing = null;
          _cloudView = null;
          _cloudSites = [];
          _cloudInventoryReady = true;
          _fbReady = false;
          _db = null;
          calInit(); sync(); rEdit(); rChips(); sw('c'); rChart();
        }
        """,
        mobile_state,
    )
    mobile_two_lane = read_two_lane_geometry(mobile_page, [1, 2, 3, 4, 5])
    assert_two_lane_geometry(mobile_two_lane)
    if screenshot_dir:
        mobile_page.locator("#pc").screenshot(path=str(screenshot_dir / "chart-two-lane-mobile.png"))
    mobile_page.locator('.chart-task-name[data-task-id="2"]').tap()
    mobile_footer_order = mobile_page.evaluate(
        """
        () => {
          const remove = document.querySelector('#chartTaskActions .remove-phase-btn').getBoundingClientRect();
          const add = document.querySelector('#chartTaskActions .add-phase-btn').getBoundingClientRect();
          const done = document.querySelector('#chartTaskActions .chart-task-done').getBoundingClientRect();
          const sheet = document.querySelector('#chartTaskOv .chart-task-sheet').getBoundingClientRect();
          return {
            removeLeft:remove.left,
            addLeft:add.left,
            doneVisible:done.top >= sheet.top && done.bottom <= sheet.bottom + .5,
            footerPosition:getComputedStyle(document.getElementById('chartTaskActions')).position
          };
        }
        """
    )
    assert mobile_footer_order["removeLeft"] < mobile_footer_order["addLeft"]
    assert mobile_footer_order["doneVisible"] is True
    assert mobile_footer_order["footerPosition"] == "sticky"
    mobile_page.locator("#chartTaskActions .chart-task-done").tap()
    mobile_page.locator("#chartTaskOv").wait_for(state="hidden")
    mobile_page.locator('.chart-task-name[data-task-id="1"]').tap()
    mobile_bounds = mobile_page.evaluate(
        """
        () => {
          const rect = document.querySelector('#chartTaskOv .chart-task-sheet').getBoundingClientRect();
          return {left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom,
                  width:innerWidth, height:innerHeight, overflow:getComputedStyle(document.getElementById('chartTaskBody')).overflowY};
        }
        """
    )
    assert mobile_bounds["left"] >= 0 and mobile_bounds["top"] >= 0
    assert mobile_bounds["right"] <= mobile_bounds["width"]
    assert mobile_bounds["bottom"] <= mobile_bounds["height"]
    assert mobile_bounds["overflow"] == "auto"
    mobile_sticky = mobile_page.evaluate(
        """
        () => {
          const body = document.getElementById('chartTaskBody');
          const footer = document.getElementById('chartTaskActions');
          const before = footer.getBoundingClientRect();
          body.scrollTop = body.scrollHeight;
          const after = footer.getBoundingClientRect();
          const done = footer.querySelector('.chart-task-done').getBoundingClientRect();
          return {
            scrollTop:body.scrollTop,
            stationary:Math.abs(before.top - after.top),
            doneBottom:done.bottom,
            viewport:innerHeight
          };
        }
        """
    )
    assert mobile_sticky["scrollTop"] > 0
    assert mobile_sticky["stationary"] <= 1
    assert mobile_sticky["doneBottom"] <= mobile_sticky["viewport"]
    mobile_page.wait_for_timeout(400)
    if screenshot_dir:
        mobile_page.screenshot(path=str(screenshot_dir / "chart-phase-mobile.png"), full_page=False)
    mobile_page.locator("#chartTaskActions .chart-task-done").tap()
    mobile_page.locator("#chartTaskOv").wait_for(state="hidden")
    mobile_page.locator("#chartAddTask").tap()
    mobile_page.locator("#chartCustomName").fill("모바일 사용자 공종")
    if screenshot_dir:
        mobile_page.screenshot(path=str(screenshot_dir / "chart-custom-mobile.png"), full_page=False)
    mobile_page.locator("#chartCustomSave").tap()
    assert mobile_page.locator("#chartTaskOv").is_visible()
    assert mobile_page.evaluate("S.tasks.some(task => task.name === '모바일 사용자 공종')") is True
    mobile_context.close()
    context.close()

    return {
        "task_on_unchanged": initial_on,
        "phase_count": persisted["phaseCount"],
        "custom_phase_count": persisted["customPhaseCount"],
        "custom_id_stable": persisted["stableId"] == custom_a,
        "readonly_unchanged": True,
        "desktop_in_viewport": True,
        "mobile_in_viewport": True,
        "pointer_edit_operations": pointer_edit_operations,
    }


NOTE_IDS = [4, 5, 1, 2, 3]


def read_note_dom_state(page, note_id):
    return page.evaluate(
        """
        noteId => {
          const note = S.notes.find(item => item.id === noteId);
          const date = nDt(note);
          const lines = Array.from(document.querySelectorAll('.dg-note-line[data-nid="' + noteId + '"]'));
          const expectedLeft = (d2i(date) + .5) * CW;
          const card = document.querySelector('.sc-card[data-note-id="' + noteId + '"]');
          const headers = Array.from(document.querySelectorAll('#gt .hd2'));
          const header = headers[d2i(date)];
          const shortLabels = {
            '간판실측 가능일':'간판실측', '주방실측 가능일':'주방실측',
            '주방집기 입고':'주방입고', '간판 설치':'간판설치', '이동식 가구':'이동가구'
          };
          return {
            id:noteId,
            label:note.label,
            date,
            mode:note.dateMode,
            lineCount:lines.length,
            linesAligned:lines.length > 0 && lines.every(line => Math.abs(parseFloat(line.style.left) - expectedLeft) <= .1),
            cardDate:card && card.querySelector('.sc-card-date').textContent.trim(),
            expectedCardDate:dspK(date),
            cardEditable:!!(card && card.classList.contains('editable')),
            headerHasLabel:!!(header && header.textContent.includes(shortLabels[note.label] || note.label.substring(0, 5))),
            outside:ScheduleCore.isNoteOutsidePeriod(note, S),
            calendarVisible:getComputedStyle(document.getElementById('tcalOv')).display !== 'none'
          };
        }
        """,
        note_id,
    )


def assert_note_dom_synced(state, expected_date, expected_mode="manual"):
    assert state["date"] == expected_date, state
    assert state["mode"] == expected_mode, state
    assert state["lineCount"] > 0 and state["linesAligned"] is True, state
    assert state["cardDate"] == state["expectedCardDate"], state
    assert state["headerHasLabel"] is True, state
    assert state["calendarVisible"] is False, state


def wait_for_note_draft(page, note_id, expected_date, expected_mode="manual"):
    page.wait_for_function(
        """
        expected => {
          const records = JSON.parse(localStorage.getItem('cs_recent') || '[]');
          const record = records.find(item => item.pn === 'Note Date QA');
          if (!record) return false;
          const saved = JSON.parse(record.snap);
          const note = saved.notes.find(item => item.id === expected.id);
          return note && note.dateMode === expected.mode && note.dt === expected.date;
        }
        """,
        arg={"id": note_id, "date": expected_date, "mode": expected_mode},
    )


def prepare_note_auto(page, note_id):
    return page.evaluate(
        """
        noteId => {
          const target = S.notes.find(note => note.id === noteId);
          if (!target || !ScheduleCore.setNoteMode(target, S, 'auto')) throw new Error('automatic note unavailable');
          const automaticDate = nDt(target);
          if (noteId === 2) {
            const overlap = S.notes.find(note => note.id === 3);
            ScheduleCore.setNoteManualDate(overlap, addD(automaticDate, 7));
          }
          rNE(); rChart(); sync(); clearTimeout(_asTimer);
          _undoStack = []; _redoStack = []; _updUR();
          window.__noteAutoSaveCalls = 0;
          return {date:automaticDate, label:target.label, state:JSON.stringify(target)};
        }
        """,
        note_id,
    )


def exercise_note_mouse_drag(page, note_id, screenshot_path=None, test_cancel=False):
    initial = prepare_note_auto(page, note_id)
    selector = f'.dg-note-line[data-nid="{note_id}"]'
    line = page.locator(selector).first
    line.scroll_into_view_if_needed()
    undo_before = page.evaluate("_undoStack.length")
    line.click()
    assert page.locator("#tcalOv").is_hidden()
    assert page.evaluate("_undoStack.length") == undo_before
    assert page.evaluate("window.__noteAutoSaveCalls") == 0
    assert page.evaluate("id => S.notes.find(note => note.id === id).dateMode", note_id) == "auto"

    if test_cancel:
        cancelled_state = page.evaluate("JSON.stringify(S)")
        box = page.locator(selector).first.bounding_box()
        assert box is not None
        cancel_x = box["x"] + box["width"] / 2
        cancel_y = box["y"] + min(12, box["height"] / 2)
        page.mouse.move(cancel_x, cancel_y)
        page.mouse.down()
        page.wait_for_timeout(700)
        page.mouse.move(cancel_x + 30, cancel_y, steps=2)
        page.evaluate(
            """
            () => {
              const press = _notePress;
              document.dispatchEvent(new PointerEvent('pointercancel', {
                pointerId:press.pointerId, pointerType:press.pointerType,
                isPrimary:true, bubbles:true
              }));
            }
            """
        )
        page.mouse.up()
        assert page.evaluate("JSON.stringify(S)") == cancelled_state
        assert page.evaluate("_undoStack.length") == undo_before
        assert page.evaluate("window.__noteAutoSaveCalls") == 0
        assert read_note_dom_state(page, note_id)["linesAligned"] is True

    line = page.locator(selector).first
    box = line.bounding_box()
    assert box is not None
    x = box["x"] + box["width"] / 2
    y = box["y"] + min(12, box["height"] / 2)
    haptics_before = page.evaluate("window.__noteHaptics.length")
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(700)
    assert page.locator(selector + ".dragging").count() > 0
    assert page.locator("#toast").text_content() == "좌우로 이동하세요"
    assert page.evaluate("window.__noteHaptics.length") == haptics_before + 1
    active_color = page.evaluate(
        "id => getComputedStyle(document.querySelector('.dg-note-line[data-nid=\"' + id + '\"]'), '::after').borderLeftColor",
        note_id,
    )
    assert active_color == "rgb(16, 185, 129)", active_color
    page.mouse.move(x + 30, y, steps=2)
    expected = page.evaluate("date => addD(date, 1)", initial["date"])
    tooltip = page.locator("#dragTip")
    assert tooltip.is_visible()
    assert initial["label"] in tooltip.inner_text() and page.evaluate("date => dspK(date)", expected) in tooltip.inner_text()
    if screenshot_path:
        page.screenshot(path=str(screenshot_path), full_page=False)
    page.mouse.up()
    page.wait_for_timeout(30)

    state = read_note_dom_state(page, note_id)
    assert_note_dom_synced(state, expected)
    assert page.locator("#tcalOv").is_hidden()
    assert page.evaluate("_undoStack.length") == undo_before + 1
    assert page.evaluate("window.__noteAutoSaveCalls") == 1
    wait_for_note_draft(page, note_id, expected)

    page.evaluate("doUndo()")
    assert_note_dom_synced(read_note_dom_state(page, note_id), initial["date"], "auto")
    page.evaluate("doRedo()")
    assert_note_dom_synced(read_note_dom_state(page, note_id), expected)
    return initial, expected


def dispatch_note_touch_drag(page, cdp, note_id, screenshot_path=None, test_cancel=False):
    initial = prepare_note_auto(page, note_id)
    selector = f'.dg-note-line[data-nid="{note_id}"]'
    line = page.locator(selector).first
    line.scroll_into_view_if_needed()
    line.tap()
    assert page.locator("#tcalOv").is_hidden()
    assert page.evaluate("_undoStack.length") == 0
    assert page.evaluate("window.__noteAutoSaveCalls") == 0

    if test_cancel:
        cancelled_state = page.evaluate("JSON.stringify(S)")
        box = page.locator(selector).first.bounding_box()
        assert box is not None
        cancel_point = {
            "x": box["x"] + box["width"] / 2,
            "y": box["y"] + min(12, box["height"] / 2),
            "radiusX": 1,
            "radiusY": 1,
            "force": 1,
            "id": 9,
        }
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [cancel_point]})
        page.wait_for_timeout(700)
        cancelled_move = dict(cancel_point)
        cancelled_move["x"] += 30
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [cancelled_move]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []})
        page.wait_for_timeout(30)
        assert page.evaluate("JSON.stringify(S)") == cancelled_state
        assert page.evaluate("_undoStack.length") == 0
        assert page.evaluate("window.__noteAutoSaveCalls") == 0
        assert read_note_dom_state(page, note_id)["linesAligned"] is True

    line = page.locator(selector).first
    box = line.bounding_box()
    assert box is not None
    x = box["x"] + box["width"] / 2
    y = box["y"] + min(12, box["height"] / 2)
    haptics_before = page.evaluate("window.__noteHaptics.length")
    point = {"x": x, "y": y, "radiusX": 1, "radiusY": 1, "force": 1, "id": 1}
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point]})
    page.wait_for_timeout(700)
    assert page.locator(selector + ".dragging").count() > 0
    assert page.locator("#toast").text_content() == "좌우로 이동하세요"
    assert page.evaluate("window.__noteHaptics.length") == haptics_before + 1
    active_color = page.evaluate(
        "id => getComputedStyle(document.querySelector('.dg-note-line[data-nid=\"' + id + '\"]'), '::after').borderLeftColor",
        note_id,
    )
    assert active_color == "rgb(16, 185, 129)", active_color
    moved = dict(point)
    moved["x"] = x + 30
    cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [moved]})
    page.wait_for_timeout(30)
    expected = page.evaluate("date => addD(date, 1)", initial["date"])
    tooltip = page.locator("#dragTip")
    assert tooltip.is_visible()
    assert initial["label"] in tooltip.inner_text() and page.evaluate("date => dspK(date)", expected) in tooltip.inner_text()
    if screenshot_path:
        page.screenshot(path=str(screenshot_path), full_page=False)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(50)

    assert_note_dom_synced(read_note_dom_state(page, note_id), expected)
    assert page.locator("#tcalOv").is_hidden()
    assert page.evaluate("_undoStack.length") == 1
    assert page.evaluate("window.__noteAutoSaveCalls") == 1
    wait_for_note_draft(page, note_id, expected)
    page.evaluate("doUndo()")
    assert_note_dom_synced(read_note_dom_state(page, note_id), initial["date"], "auto")
    page.evaluate("doRedo()")
    assert_note_dom_synced(read_note_dom_state(page, note_id), expected)
    return initial, expected


def restore_note_auto_with_ui(page, note_id, label, automatic_date, mobile=False):
    page.locator("#te").tap() if mobile else page.locator("#te").click()
    group = page.get_by_role("group", name=f"{label} 배치 방식")
    auto_button = group.get_by_role("button", name="자동")
    auto_button.tap() if mobile else auto_button.click()
    page.locator("#tc2").tap() if mobile else page.locator("#tc2").click()
    assert_note_dom_synced(read_note_dom_state(page, note_id), automatic_date, "auto")


def change_note_from_card(page, note_id, target_date, mobile=False, screenshot_path=None):
    page.evaluate(
        """
        () => {
          clearTimeout(_asTimer); _undoStack = []; _redoStack = []; _updUR();
          window.__noteAutoSaveCalls = 0;
        }
        """
    )
    card = page.locator(f'.sc-card[data-note-id="{note_id}"]')
    card.scroll_into_view_if_needed()
    card.tap() if mobile else card.click()
    assert page.locator("#tcalOv").is_visible()
    assert page.evaluate("_ncalId") == note_id
    if screenshot_path:
        page.screenshot(path=str(screenshot_path), full_page=False)
    day = page.locator(f'#tcalOv .tcal-dn[data-ds="{target_date}"]').first
    day.tap() if mobile else day.click()
    page.locator("#tcalOv").wait_for(state="hidden")
    assert_note_dom_synced(read_note_dom_state(page, note_id), target_date)
    assert page.evaluate("_undoStack.length") == 1
    assert page.evaluate("window.__noteAutoSaveCalls") == 1
    wait_for_note_draft(page, note_id, target_date)
    page.evaluate("doUndo()")
    assert page.evaluate("id => S.notes.find(note => note.id === id).dateMode", note_id) == "auto"
    page.evaluate("doRedo()")
    assert_note_dom_synced(read_note_dom_state(page, note_id), target_date)
    page.evaluate("clearTimeout(_asTimer); window.__noteAutoSaveCalls = 0")
    undo_before = page.evaluate("_undoStack.length")
    card = page.locator(f'.sc-card[data-note-id="{note_id}"]')
    card.tap() if mobile else card.click()
    same_day = page.locator(f'#tcalOv .tcal-dn[data-ds="{target_date}"]').first
    same_day.tap() if mobile else same_day.click()
    page.locator("#tcalOv").wait_for(state="hidden")
    assert page.evaluate("_undoStack.length") == undo_before
    assert page.evaluate("window.__noteAutoSaveCalls") == 0
    assert_note_dom_synced(read_note_dom_state(page, note_id), target_date)


def setup_note_page(page):
    page.evaluate(
        """
        () => {
          const state = defaultState();
          state.pn = 'Note Date QA'; state.sd = '2026-08-01'; state.ed = '2026-09-20';
          state.tasks.forEach(task => { task.on = false; });
          const ranges = {
            4:['2026-08-05','2026-08-10'],
            8:['2026-08-10','2026-08-15'],
            9:['2026-08-16','2026-08-20'],
            14:['2026-08-24','2026-08-25']
          };
          Object.keys(ranges).forEach(rawId => {
            const task = state.tasks.find(item => item.id === Number(rawId));
            task.on = true; task.sd = ranges[rawId][0]; task.ed = ranges[rawId][1]; task.scheduleMode = 'auto';
          });
          state.notes.forEach(note => { note.dateMode = 'auto'; note.dt = ''; });
          const record = {pn:state.pn,sd:state.sd,ed:state.ed,confirmed:false,savedAt:'2026-08-07 12:00',snap:JSON.stringify(state)};
          localStorage.setItem('cs_recent', JSON.stringify([record])); localStorage.setItem('cs_last', state.pn);
          S = ScheduleCore.normalizeScheduleState(state); _origPn = state.pn; _cancelPn = null; _open = null;
          IS_RO = false; _cloudEditing = null; _cloudView = null; _cloudSites = []; _cloudInventoryReady = true;
          _fbReady = false; _db = null; _undoStack = []; _redoStack = [];
          calInit(); sync(); rEdit(); rChips(); sw('c'); rChart(); clearTimeout(_asTimer);
          window.__noteAutoSaveCalls = 0;
          window.__noteAutoSaveOriginal = autoSave;
          autoSave = function(){ window.__noteAutoSaveCalls++; return window.__noteAutoSaveOriginal.apply(this, arguments); };
        }
        """
    )


def run_note_date_interactions(
    browser,
    origin,
    route_request,
    screenshot_dir,
    console_errors,
    page_errors,
    request_failures,
):
    results = {}
    reload_results = {}
    for label, viewport, mobile in (
        ("desktop", {"width": 1440, "height": 1000}, False),
        ("mobile", {"width": 390, "height": 844}, True),
    ):
        context = browser.new_context(
            viewport=viewport,
            is_mobile=mobile,
            has_touch=mobile,
        )
        context.add_init_script(
            """
            window.__ISM_TEST_MODE__ = true;
            if (!sessionStorage.getItem('__noteQaBoot')) {
              localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__noteQaBoot', '1');
            }
            localStorage.setItem('_deviceName', 'note-date-qa');
            localStorage.setItem('_gcalEnabled', '0');
            window.__noteHaptics = [];
            Object.defineProperty(navigator, 'vibrate', {
              configurable:true,
              value:value => { window.__noteHaptics.push(value); return true; }
            });
            """
        )
        context.route("**/*", route_request)
        page = context.new_page()
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}"))
        page.goto(origin + "/", wait_until="domcontentloaded")
        setup_note_page(page)
        cdp = context.new_cdp_session(page) if mobile else None
        operations = 0
        final_dates = {}

        for index, note_id in enumerate(NOTE_IDS):
            active_capture = None
            calendar_capture = None
            if screenshot_dir and index == 0:
                active_capture = screenshot_dir / f"note-drag-active-{label}.png"
                calendar_capture = screenshot_dir / f"note-calendar-{label}.png"
            if mobile:
                initial, _ = dispatch_note_touch_drag(page, cdp, note_id, active_capture, test_cancel=index == 0)
            else:
                initial, _ = exercise_note_mouse_drag(page, note_id, active_capture, test_cancel=index == 0)
            restore_note_auto_with_ui(page, note_id, initial["label"], initial["date"], mobile)
            target = (
                page.evaluate("addD(S.ed, 5)")
                if note_id == 3
                else page.evaluate("date => addD(date, 2)", initial["date"])
            )
            change_note_from_card(page, note_id, target, mobile, calendar_capture)
            if note_id == 3:
                assert read_note_dom_state(page, note_id)["outside"] is True
                assert page.locator("#en .note-date-warning").count() > 0
            final_dates[str(note_id)] = target
            operations += 2

        page.wait_for_function(
            """
            expected => {
              const records = JSON.parse(localStorage.getItem('cs_recent') || '[]');
              const record = records.find(item => item.pn === 'Note Date QA');
              if (!record) return false;
              const saved = JSON.parse(record.snap);
              return Object.keys(expected).every(id => {
                const note = saved.notes.find(item => item.id === Number(id));
                return note && note.dateMode === 'manual' && note.dt === expected[id];
              });
            }
            """,
            arg=final_dates,
        )
        if screenshot_dir:
            if mobile:
                page.evaluate(
                    """
                    () => {
                      if (_stickyObserver) _stickyObserver.disconnect();
                      _removeStickyHeader();
                      document.getElementById('scw').scrollIntoView({block:'end'});
                    }
                    """
                )
                page.screenshot(path=str(screenshot_dir / f"note-bidirectional-{label}.png"), full_page=False)
            else:
                page.locator("#pa").screenshot(path=str(screenshot_dir / f"note-bidirectional-{label}.png"))

        page.reload(wait_until="domcontentloaded")
        page.wait_for_function("S && S.pn === 'Note Date QA'")
        page.evaluate("sw('c'); rChart()")
        reloaded = page.evaluate(
            """
            expected => Object.keys(expected).every(id => {
              const note = S.notes.find(item => item.id === Number(id));
              return note && note.dateMode === 'manual' && note.dt === expected[id];
            })
            """,
            final_dates,
        )
        assert reloaded is True
        reload_results[label] = reloaded

        readonly_before = page.evaluate("JSON.stringify(S)")
        page.evaluate("IS_RO = true; rChart(); _undoStack = []; _redoStack = []; _updUR()")
        assert page.locator(".dg-note-line.editable").count() == 0
        assert page.locator('.sc-card[role="button"]').count() == 0
        for readonly_index, note_id in enumerate(NOTE_IDS):
            readonly_line = page.locator(f'.dg-note-line[data-nid="{note_id}"]').first
            readonly_line.scroll_into_view_if_needed()
            box = readonly_line.bounding_box()
            assert box is not None
            if mobile:
                point = {
                    "x": box["x"] + 8,
                    "y": box["y"] + 8,
                    "radiusX": 1,
                    "radiusY": 1,
                    "force": 1,
                    "id": readonly_index + 20,
                }
                cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [point]})
                page.wait_for_timeout(700)
                point["x"] += 30
                cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [point]})
                cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
            else:
                page.mouse.move(box["x"] + 8, box["y"] + 8)
                page.mouse.down()
                page.wait_for_timeout(700)
                page.mouse.move(box["x"] + 38, box["y"] + 8)
                page.mouse.up()
        assert page.evaluate("JSON.stringify(S)") == readonly_before
        assert page.evaluate("_undoStack.length") == 0
        assert page.locator("#tcalOv").is_hidden()

        results[label] = {
            "operations": operations,
            "simple_click_calendar_opens": 0,
            "long_press_drags": len(NOTE_IDS),
            "card_calendar_changes": len(NOTE_IDS),
            "same_date_noop": len(NOTE_IDS),
            "cancelled_drag_mutations": 0,
            "readonly_attempts": len(NOTE_IDS),
            "readonly_unchanged": True,
        }
        context.close()

    return {
        "desktop": results["desktop"],
        "mobile": results["mobile"],
        "reload_exact": all(reload_results.values()),
    }


def run():
    handler = partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    screenshot_dir = Path(os.environ["ISM_SCREENSHOT_DIR"]) if os.environ.get("ISM_SCREENSHOT_DIR") else None
    if screenshot_dir:
        screenshot_dir.mkdir(parents=True, exist_ok=True)

    console_errors = []
    page_errors = []
    request_failures = []
    unexpected_mutations = []
    intercepted_config_requests = 0

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script(
                """
                window.__ISM_TEST_MODE__ = true;
                localStorage.clear();
                sessionStorage.clear();
                localStorage.setItem('_deviceName', 'isolated-qa');
                localStorage.setItem('_gcalEnabled', '0');
                """
            )

            def route_request(route):
                nonlocal intercepted_config_requests
                request = route.request
                if request.url == origin + "/api/calendar" and request.method == "POST":
                    try:
                        payload = json.loads(request.post_data or "{}")
                    except json.JSONDecodeError:
                        payload = {}
                    if payload.get("action") == "config":
                        intercepted_config_requests += 1
                        route.fulfill(
                            status=200,
                            content_type="application/json",
                            body=json.dumps({"detailCalId": "qa-detail", "simpleCalId": "qa-simple"}),
                        )
                        return
                    unexpected_mutations.append({"method": request.method, "url": request.url})
                    route.abort()
                    return
                if request.url.startswith(origin) and request.method in ("GET", "HEAD"):
                    route.continue_()
                    return
                if request.method not in ("GET", "HEAD"):
                    unexpected_mutations.append({"method": request.method, "url": request.url})
                    route.abort()
                    return
                content_type = "application/javascript" if request.resource_type == "script" else "text/css"
                route.fulfill(status=200, content_type=content_type, body="")

            context.route("**/*", route_request)
            page = context.new_page()
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}"))
            page.goto(origin + "/", wait_until="domcontentloaded")

            page.evaluate(
                """
                () => {
                  const state = defaultState();
                  state.pn = 'Site A';
                  const automatic = state.tasks.find(task => task.id === 1);
                  automatic.on = true;
                  automatic.sd = '2026-08-05';
                  automatic.ed = '2026-08-08';
                  automatic.scheduleMode = 'auto';
                  const manual = state.tasks.find(task => task.id === 2);
                  manual.on = true;
                  manual.sd = '2026-07-20';
                  manual.ed = '2026-07-22';
                  manual.scheduleMode = 'manual';
                  const manualTile = state.tasks.find(task => task.id === 9);
                  manualTile.on = true;
                  manualTile.sd = '2026-09-08';
                  manualTile.ed = '2026-09-10';
                  manualTile.scheduleMode = 'manual';
                  state.sd = '2026-08-05';
                  state.ed = '2026-09-01';
                  const siteA = {pn:'Site A', sd:state.sd, ed:state.ed, confirmed:true, snap:JSON.stringify(state)};
                  const siteBState = defaultState();
                  siteBState.pn = 'Site B';
                  siteBState.marker = 'B-original';
                  const siteB = {pn:'Site B', sd:siteBState.sd, ed:siteBState.ed, confirmed:false, snap:JSON.stringify(siteBState)};
                  localStorage.setItem('cs_recent', JSON.stringify([siteA, siteB]));
                  localStorage.setItem('cs_last', 'Site A');
                  S = state;
                  _origPn = 'Site A';
                  IS_RO = true;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  _fbReady = true;
                  _db = {
                    collection: () => ({
                      doc: () => ({ delete: async () => {} })
                    })
                  };
                  calInit(); sync(); rEdit(); rChips(); rChart();
                }
                """
            )

            page.evaluate(
                """
                () => {
                  _db = {
                    collection: () => ({
                      doc: () => ({ delete: async () => { throw new Error('synthetic delete failure'); } })
                    })
                  };
                }
                """
            )
            page.locator('.pnchip-confirm[data-pn="Site A"]').click()
            page.wait_for_function("!_confirmBusy['Site A']")
            assert page.evaluate(
                "JSON.parse(localStorage.getItem('cs_recent')).find(item => item.pn === 'Site A').confirmed"
            ) is True
            page.evaluate(
                """
                () => {
                  _db = {
                    collection: () => ({
                      doc: () => ({
                        delete: () => new Promise(resolve => { window.__resolveDelayedDelete = resolve; })
                      })
                    })
                  };
                }
                """
            )
            page.locator('.pnchip-confirm[data-pn="Site A"]').click()
            page.wait_for_function("typeof window.__resolveDelayedDelete === 'function'")
            page.evaluate(
                """
                () => {
                  const records = JSON.parse(localStorage.getItem('cs_recent'));
                  const siteB = records.find(item => item.pn === 'Site B');
                  const stateB = JSON.parse(siteB.snap);
                  stateB.marker = 'B-concurrent';
                  siteB.snap = JSON.stringify(stateB);
                  localStorage.setItem('cs_recent', JSON.stringify(records));
                  window.__resolveDelayedDelete();
                }
                """
            )
            page.wait_for_function("!_confirmBusy['Site A']")
            assert page.evaluate(
                "JSON.parse(JSON.parse(localStorage.getItem('cs_recent')).find(item => item.pn === 'Site B').snap).marker"
            ) == "B-concurrent"
            page.locator('.cal-dn[data-ds="2026-08-10"]').click()
            page.locator('.cal-dn[data-ds="2026-09-10"]').click()
            period_result = page.evaluate(
                """
                () => ({
                  confirmed: JSON.parse(localStorage.getItem('cs_recent'))[0].confirmed,
                  sd: S.sd,
                  ed: S.ed,
                  automatic: S.tasks.find(task => task.id === 1),
                  manual: S.tasks.find(task => task.id === 2),
                  electrical: S.tasks.find(task => task.id === 5),
                  hvac: S.tasks.find(task => task.id === 10)
                })
                """
            )
            assert period_result["confirmed"] is False
            assert period_result["sd"] == "2026-08-10"
            assert period_result["ed"] == "2026-09-10"
            assert period_result["automatic"]["sd"] == "2026-08-10"
            assert period_result["manual"]["sd"] == "2026-07-20"
            assert period_result["manual"]["ed"] == "2026-07-22"
            for dependent_task in (period_result["electrical"], period_result["hvac"]):
                assert dependent_task["sd2"] <= dependent_task["ed2"]
                assert dependent_task["ed2"] <= period_result["ed"]
            auto_range_matrix = page.evaluate(
                """
                () => S.tasks.filter(task => task.on).flatMap(task => ScheduleCore.getTaskPhases(task, {activeOnly:true, validOnly:true}))
                  .filter(phase => phase.mode === 'auto')
                  .map(phase => ({sd:phase.sd, ed:phase.ed, inside:phase.sd >= S.sd && phase.ed <= S.ed && phase.sd <= phase.ed}))
                """
            )
            assert auto_range_matrix
            assert all(item["inside"] for item in auto_range_matrix), auto_range_matrix

            page.evaluate(
                """
                () => {
                  const bar = document.querySelector('.bar[data-id="1"]');
                  bar.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:200}));
                  document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, clientX:200}));
                }
                """
            )
            assert page.evaluate("S.tasks.find(task => task.id === 1).scheduleMode") == "auto"

            page.locator("#fn").fill("Site B")
            page.wait_for_timeout(950)
            autosave_result = page.evaluate(
                """
                () => {
                  const records = JSON.parse(localStorage.getItem('cs_recent'));
                  return {
                    a: JSON.parse(records.find(item => item.pn === 'Site A').snap),
                    b: JSON.parse(records.find(item => item.pn === 'Site B').snap)
                  };
                }
                """
            )
            assert autosave_result["a"]["pn"] == "Site A"
            assert autosave_result["b"]["marker"] == "B-concurrent"

            page.evaluate(
                """
                () => {
                  const records = JSON.parse(localStorage.getItem('cs_recent'));
                  S = JSON.parse(records.find(item => item.pn === 'Site A').snap);
                  _origPn = 'Site A';
                  IS_RO = false;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  sync(); rEdit(); rChips();
                }
                """
            )
            page.locator("#fn").fill("site a")
            page.locator("#pnSaveBtn").click()
            page.wait_for_function(
                "JSON.parse(localStorage.getItem('cs_recent')).some(item => item.pn === 'site a')"
            )
            normalized_rename = page.evaluate(
                """
                () => {
                  const records = JSON.parse(localStorage.getItem('cs_recent'));
                  return {
                    originalExists: records.some(item => item.pn === 'Site A'),
                    renamedExists: records.some(item => item.pn === 'site a'),
                    activeIdentity: _origPn
                  };
                }
                """
            )
            assert normalized_rename == {
                "originalExists": False,
                "renamedExists": True,
                "activeIdentity": "site a",
            }

            page.evaluate(
                """
                () => {
                  const state = defaultState();
                  state.pn = 'Confirm Failure';
                  const item = {
                    pn: state.pn,
                    sd: state.sd,
                    ed: state.ed,
                    confirmed: false,
                    snap: JSON.stringify(state)
                  };
                  localStorage.setItem('cs_recent', JSON.stringify([item]));
                  S = state;
                  _origPn = state.pn;
                  IS_RO = false;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  window.__confirmFailureOriginalSave = saveToCloud;
                  window.__confirmFailureOriginalDelete = deleteFromCloud;
                  window.__confirmFailureDeleteCalls = 0;
                  saveToCloud = async () => false;
                  deleteFromCloud = async () => { window.__confirmFailureDeleteCalls += 1; return true; };
                  sync(); rEdit(); rChips();
                }
                """
            )
            page.locator('.pnchip-confirm[data-pn="Confirm Failure"]').click()
            page.wait_for_function("!_confirmBusy['Confirm Failure']")
            confirm_failure_guard = page.evaluate(
                """
                () => {
                  const item = JSON.parse(localStorage.getItem('cs_recent'))[0];
                  const result = {confirmed:item.confirmed, deleteCalls:window.__confirmFailureDeleteCalls};
                  saveToCloud = window.__confirmFailureOriginalSave;
                  deleteFromCloud = window.__confirmFailureOriginalDelete;
                  return result;
                }
                """
            )
            assert confirm_failure_guard == {"confirmed": False, "deleteCalls": 0}

            page.evaluate(
                """
                () => {
                  S = defaultState();
                  S.pn = '';
                  _origPn = null;
                  IS_RO = false;
                  _cloudSites = [{pn:'ＳＥＯＵＬ\u3000Site', tasks:[]}];
                  _cloudInventoryReady = true;
                  sync(); rEdit(); rChips();
                }
                """
            )
            page.locator("#fn").fill("  seoul   site  ")
            page.locator("#pnSaveBtn").click()
            page.locator("#conflictModalBg").wait_for(state="visible")
            assert page.locator("#conflictModalBg").get_by_text("기존 현장 열기").count() == 1
            assert page.locator("#conflictModalBg").get_by_text("이름 변경하러 가기").count() == 1
            assert page.evaluate(
                "JSON.parse(localStorage.getItem('cs_recent')).some(item => ScheduleCore.canonicalSiteName(item.pn) === 'seoul site')"
            ) is False

            page.locator("#conflictModalBg .master-modal-cancel").click()
            cloud_edit_guard = page.evaluate(
                """
                async () => {
                  let writes = 0;
                  const originalSave = saveToCloud;
                  saveToCloud = async () => { writes += 1; return true; };
                  _cloudEditing = 'Cloud Original';
                  S = defaultState();
                  S.pn = ' SITE   B ';
                  _cloudSites = [{pn:'Cloud Original'}, {pn:'Site B'}];
                  _cloudInventoryReady = true;
                  await _cloudEditSave();
                  saveToCloud = originalSave;
                  return {writes, modal: !!document.getElementById('conflictModalBg')};
                }
                """
            )
            assert cloud_edit_guard == {"writes": 0, "modal": True}

            page.evaluate(
                """
                () => {
                  const conflict = document.getElementById('conflictModalBg');
                  if (conflict) conflict.remove();
                  localStorage.clear();
                  sessionStorage.clear();
                  localStorage.setItem('_deviceName', 'isolated-qa');
                  localStorage.setItem('_gcalEnabled', '0');
                  S = ScheduleCore.normalizeScheduleState(defaultState());
                  _origPn = null;
                  _cancelPn = null;
                  _open = null;
                  IS_RO = false;
                  _cloudEditing = null;
                  _cloudView = null;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  sync(); rEdit(); rChips(); rChart();
                }
                """
            )
            page.locator("#taskCard1 > .th2").click()
            page.locator('.add-phase-btn[data-task-id="1"]').click()
            page.locator(".add-custom-task-btn").click()
            unsaved_custom_id = page.evaluate("S.tasks.find(task => task.custom).id")
            page.locator(f'.phase-name[data-task-id="{unsaved_custom_id}"][data-phase="1"]').fill(
                "최초 저장 사용자 공종"
            )
            page.locator("#fn").fill("First Save QA")
            page.locator("#pnSaveBtn").click()
            page.wait_for_function(
                "JSON.parse(localStorage.getItem('cs_recent') || '[]').some(item => item.pn === 'First Save QA')"
            )
            first_save_round_trip = page.evaluate(
                f"""
                () => {{
                  const record = JSON.parse(localStorage.getItem('cs_recent')).find(item => item.pn === 'First Save QA');
                  const restored = ScheduleCore.normalizeScheduleState(JSON.parse(record.snap));
                  return {{
                    phaseCount:ScheduleCore.getTaskPhaseCount(restored.tasks.find(item => item.id === 1)),
                    customName:restored.tasks.find(item => item.id === {unsaved_custom_id}).name
                  }};
                }}
                """
            )
            assert first_save_round_trip == {
                "phaseCount": 2,
                "customName": "최초 저장 사용자 공종",
            }

            cloud_restore_round_trip = page.evaluate(
                """
                () => {
                  const cloudState = defaultState();
                  cloudState.pn = 'Cloud Restore QA';
                  cloudState.author = getDeviceName();
                  const task = cloudState.tasks.find(item => item.id === 1);
                  while (ScheduleCore.getTaskPhaseCount(task) < 5) {
                    const phase = ScheduleCore.addTaskPhase(task, {mode:'manual'});
                    ScheduleCore.updateTaskPhase(task, phase.index, {
                      sd:addD(cloudState.sd, phase.index),
                      ed:addD(cloudState.sd, phase.index + 1),
                      name:'복구 ' + phase.index + '차',
                      mode:'manual'
                    });
                  }
                  ScheduleCore.createCustomTask(cloudState, {
                    id:1000000123,
                    name:'복구 사용자 공종'
                  });
                  localStorage.removeItem('cs_recent');
                  _cloudSites = [ScheduleCore.normalizeScheduleState(cloudState)];
                  _restoreMyCloudSites();
                  const record = JSON.parse(localStorage.getItem('cs_recent'))[0];
                  const restored = ScheduleCore.normalizeScheduleState(JSON.parse(record.snap));
                  return {
                    confirmed:record.confirmed,
                    phaseCount:ScheduleCore.getTaskPhaseCount(restored.tasks.find(item => item.id === 1)),
                    phase5Name:ScheduleCore.getTaskPhase(restored.tasks.find(item => item.id === 1), 5).name,
                    customName:restored.tasks.find(item => item.custom).name
                  };
                }
                """
            )
            assert cloud_restore_round_trip == {
                "confirmed": True,
                "phaseCount": 5,
                "phase5Name": "복구 5차",
                "customName": "복구 사용자 공종",
            }

            page.evaluate(
                """
                () => {
                  clearTimeout(_asTimer);
                  const conflict = document.getElementById('conflictModalBg');
                  if (conflict) conflict.remove();
                  localStorage.clear();
                  sessionStorage.clear();
                  localStorage.setItem('_deviceName', 'isolated-qa');
                  localStorage.setItem('_gcalEnabled', '0');

                  const qa = defaultState();
                  qa.pn = 'Wave2 QA';
                  qa.sd = '2026-08-05';
                  qa.ed = '2026-09-01';
                  const manual = qa.tasks.find(task => task.id === 2);
                  manual.on = true;
                  manual.sd = '2026-07-20';
                  manual.ed = '2026-07-22';
                  manual.scheduleMode = 'manual';

                  const other = defaultState();
                  other.pn = 'Wave2 Other';
                  other.sd = '2026-08-05';
                  other.ed = '2026-09-01';
                  const records = [qa, other].map(state => ({
                    pn: state.pn,
                    sd: state.sd,
                    ed: state.ed,
                    confirmed: false,
                    savedAt: '2026-08-05 12:00',
                    snap: JSON.stringify(state)
                  }));
                  localStorage.setItem('cs_recent', JSON.stringify(records));
                  localStorage.setItem('cs_last', qa.pn);

                  S = ScheduleCore.normalizeScheduleState(qa);
                  _origPn = qa.pn;
                  _cancelPn = null;
                  _open = null;
                  IS_RO = false;
                  _cloudEditing = null;
                  _cloudView = null;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  _fbReady = false;
                  _db = null;
                  calInit(); sync(); rEdit(); rChips(); rChart();
                }
                """
            )

            assert page.evaluate(
                "ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))"
            ) == 1
            page.locator("#taskCard1 > .th2").click()
            assert page.locator('#taskCard1 .phase-name[data-phase="1"]').count() == 1
            for expected_count in range(2, 6):
                page.locator('.add-phase-btn[data-task-id="1"]').click()
                assert page.evaluate(
                    "ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))"
                ) == expected_count

            page.locator('.phase-name[data-task-id="1"][data-phase="4"]').fill("가설 4차")
            page.locator('.phase-desc[data-task-id="1"][data-phase="4"]').fill("4차 설명")
            page.locator('.phase-name[data-task-id="1"][data-phase="5"]').fill("가설 5차")
            page.locator('.remove-phase-btn[data-task-id="1"]').click()
            assert page.evaluate(
                "ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1))"
            ) == 4
            page.locator('.add-phase-btn[data-task-id="1"]').click()
            page.locator('.phase-name[data-task-id="1"][data-phase="5"]').fill("가설 5차 재추가")

            phase_four_dates = page.locator('.phase-date[data-task-id="1"][data-phase="4"]')
            phase_four_dates.locator(".date-disp").first.click()
            page.locator('#tcalOv .tcal-dn[data-ds="2026-08-19"]').click()
            page.locator('#tcalOv .tcal-dn[data-ds="2026-08-20"]').click()
            page.locator("#tcalOv").wait_for(state="hidden")
            assert page.evaluate(
                """
                () => {
                  const phase = ScheduleCore.getTaskPhase(S.tasks.find(task => task.id === 1), 4);
                  return phase.sd === '2026-08-19' && phase.ed === '2026-08-20' && phase.mode === 'manual';
                }
                """
            ) is True

            page.locator(".add-custom-task-btn").click()
            custom_id = page.evaluate("S.tasks.find(task => task.custom === true).id")
            page.locator(f'.phase-name[data-task-id="{custom_id}"][data-phase="1"]').fill("보양공사")
            page.locator(f'.phase-desc[data-task-id="{custom_id}"][data-phase="1"]').fill("사용자 정의 공종")
            page.locator(f'.add-phase-btn[data-task-id="{custom_id}"]').click()
            page.locator(f'.phase-name[data-task-id="{custom_id}"][data-phase="2"]').fill("보양 보완")
            page.locator("#ctorMgrHeader").click()
            page.locator(f"#ctorFi_{custom_id}").fill("QA 협력사")
            page.locator(f"#ctorFi_{custom_id}").press("Enter")
            page.locator(f"#taskCard{custom_id} .togr .tog").click()
            assert page.evaluate(f"S.tasks.find(task => task.id === {custom_id}).on") is False
            page.locator(f"#taskCard{custom_id} .togr .tog").click()
            assert page.evaluate(f"S.tasks.find(task => task.id === {custom_id}).on") is True

            page.locator("#tabs > #tc2").click()
            assert page.locator('.bar[data-task-id="1"][data-phase]').count() == 5
            assert page.locator(f'.bar[data-task-id="{custom_id}"][data-phase]').count() == 2
            assert page.evaluate("getDt()[0].ds") == "2026-07-20"
            assert page.evaluate(
                "Math.round(document.querySelector('.bar[data-task-id=\"2\"][data-phase=\"1\"]').getBoundingClientRect().width)"
            ) == 90

            assert page.locator(".chart-range-guide").count() == 0
            phase_four_bar = page.locator('.bar[data-task-id="1"][data-phase="4"]')
            period_before_selection = page.evaluate("({sd:S.sd,ed:S.ed})")
            phase_four_box = phase_four_bar.bounding_box()
            page.mouse.move(
                phase_four_box["x"] + phase_four_box["width"] / 2,
                phase_four_box["y"] + phase_four_box["height"] / 2,
            )
            page.mouse.down()
            assert page.locator(".chart-range-guide").count() == 2
            page.mouse.move(
                phase_four_box["x"] + phase_four_box["width"] / 2 + 5,
                phase_four_box["y"] + phase_four_box["height"] / 2,
            )
            desktop_chart_metrics = page.evaluate(
                """
                () => {
                  const bar = document.querySelector('.bar[data-task-id="1"][data-phase="4"]');
                  const guides = Array.from(document.querySelectorAll('.chart-range-guide'));
                  const layer = document.getElementById('chartRangeGuides');
                  const tbody = document.querySelector('#gt tbody');
                  const thead = document.querySelector('#gt thead');
                  const barRect = bar.getBoundingClientRect();
                  const bodyRect = tbody.getBoundingClientRect();
                  const headRect = thead.getBoundingClientRect();
                  const guideRects = guides.map(guide => guide.getBoundingClientRect());
                  const rows = Array.from(document.querySelectorAll('#gt tbody tr'));
                  const lanesClear = rows.every(row => {
                    const bars = Array.from(row.querySelectorAll('.bar')).map(item => item.getBoundingClientRect());
                    return bars.every((first, index) => bars.slice(index + 1).every(second => {
                      const xOverlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
                      const yOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
                      return xOverlap <= .5 || yOverlap <= .5;
                    }));
                  });
                  const selectedRow = bar.closest('tr');
                  const selectedBars = Array.from(selectedRow.querySelectorAll('.bar'));
                  const center = item => {
                    const rect = item.getBoundingClientRect();
                    return (rect.top + rect.bottom) / 2;
                  };
                  const oddCenters = selectedBars.filter(item => Number(item.dataset.phase) % 2 === 1).map(center);
                  const evenCenters = selectedBars.filter(item => Number(item.dataset.phase) % 2 === 0).map(center);
                  const allBounded = Array.from(document.querySelectorAll('#gt .bar')).every(item => {
                    const style = getComputedStyle(item);
                    return style.borderLeftWidth === '1px' && style.borderRightWidth === '1px';
                  });
                  return {
                    guides:guides.length,
                    selected:document.querySelectorAll('#gt .bar.chart-selected').length,
                    startError:Math.abs(guideRects[0].left - barRect.left),
                    endError:Math.abs(guideRects[1].left - (barRect.right - 1)),
                    topError:Math.abs(guideRects[0].top - bodyRect.top),
                    bottomError:Math.abs(guideRects[0].bottom - bodyRect.bottom),
                    headerClear:guideRects[0].top >= headRect.bottom - 1,
                    pointerEvents:getComputedStyle(layer).pointerEvents,
                    layerZ:Number(getComputedStyle(layer).zIndex),
                    barZ:Number(getComputedStyle(bar).zIndex),
                    lanesClear,
                    fixedRowHeight:Math.round(selectedRow.getBoundingClientRect().height),
                    oddAligned:Math.max(...oddCenters) - Math.min(...oddCenters) <= 1,
                    evenAligned:Math.max(...evenCenters) - Math.min(...evenCenters) <= 1,
                    allBounded
                  };
                }
                """
            )
            assert desktop_chart_metrics["guides"] == 2
            assert desktop_chart_metrics["selected"] == 1
            assert desktop_chart_metrics["startError"] <= 1
            assert desktop_chart_metrics["endError"] <= 1
            assert desktop_chart_metrics["topError"] <= 1
            assert desktop_chart_metrics["bottomError"] <= 1
            assert desktop_chart_metrics["headerClear"] is True
            assert desktop_chart_metrics["pointerEvents"] == "none"
            assert desktop_chart_metrics["layerZ"] < desktop_chart_metrics["barZ"]
            assert desktop_chart_metrics["lanesClear"] is True
            assert desktop_chart_metrics["fixedRowHeight"] == 56
            assert desktop_chart_metrics["oddAligned"] is True
            assert desktop_chart_metrics["evenAligned"] is True
            assert desktop_chart_metrics["allBounded"] is True
            page.mouse.up()
            assert page.locator(".chart-range-guide").count() == 2
            assert page.evaluate("({sd:S.sd,ed:S.ed})") == period_before_selection
            if screenshot_dir:
                phase_four_bar.scroll_into_view_if_needed()
                page.screenshot(path=str(screenshot_dir / "wave3-desktop.png"), full_page=False)

            page.locator("#pc .cs").dispatch_event("mousedown")
            assert page.locator(".chart-range-guide").count() == 0
            phase_four_bar.dispatch_event(
                "mousedown",
                {
                    "button": 0,
                    "clientX": phase_four_box["x"] + phase_four_box["width"] / 2,
                    "clientY": phase_four_box["y"] + phase_four_box["height"] / 2,
                },
            )
            assert page.locator(".chart-range-guide").count() == 2
            page.keyboard.press("Escape")
            assert page.locator(".chart-range-guide").count() == 0
            page.evaluate("if (drag) { drag = null; document.removeEventListener('mousemove', oMM); document.removeEventListener('mouseup', oMU); }")

            mobile_state = page.evaluate("JSON.parse(JSON.stringify(S))")
            mobile_context = browser.new_context(
                viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True
            )
            mobile_context.add_init_script(
                """
                window.__ISM_TEST_MODE__ = true;
                localStorage.clear();
                sessionStorage.clear();
                localStorage.setItem('_deviceName', 'isolated-mobile-qa');
                localStorage.setItem('_gcalEnabled', '0');
                """
            )
            mobile_context.route("**/*", route_request)
            mobile_page = mobile_context.new_page()
            mobile_page.on(
                "console", lambda message: console_errors.append(message.text) if message.type == "error" else None
            )
            mobile_page.on("pageerror", lambda error: page_errors.append(str(error)))
            mobile_page.on("requestfailed", lambda request: request_failures.append(f"{request.method} {request.url}"))
            mobile_page.goto(origin + "/", wait_until="domcontentloaded")
            mobile_page.evaluate(
                """
                state => {
                  S = ScheduleCore.normalizeScheduleState(state);
                  _origPn = state.pn;
                  IS_RO = false;
                  _cloudEditing = null;
                  _cloudView = null;
                  _cloudSites = [];
                  _cloudInventoryReady = true;
                  _fbReady = false;
                  _db = null;
                  calInit(); sync(); rEdit(); rChips(); sw('c'); rChart();
                }
                """,
                mobile_state,
            )
            mobile_phase_four = mobile_page.locator('.bar[data-task-id="1"][data-phase="4"]')
            mobile_phase_four.tap()
            assert mobile_page.locator(".chart-range-guide").count() == 2
            mobile_chart_metrics = mobile_page.evaluate(
                """
                () => {
                  const bar = document.querySelector('.bar[data-task-id="1"][data-phase="4"]');
                  const guides = Array.from(document.querySelectorAll('.chart-range-guide'));
                  const layer = document.getElementById('chartRangeGuides');
                  const tbody = document.querySelector('#gt tbody');
                  const thead = document.querySelector('#gt thead');
                  const barRect = bar.getBoundingClientRect();
                  const bodyRect = tbody.getBoundingClientRect();
                  const headRect = thead.getBoundingClientRect();
                  const guideRects = guides.map(guide => guide.getBoundingClientRect());
                  const selectedRow = bar.closest('tr');
                  const selectedRowBars = Array.from(selectedRow.querySelectorAll('.bar')).map(item => ({
                    phase:Number(item.dataset.phase),
                    lane:item.dataset.lane,
                    rect:item.getBoundingClientRect()
                  }));
                  const lanesClear = selectedRowBars.every((first, index) => selectedRowBars.slice(index + 1).every(second => {
                    const xOverlap = Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left);
                    const yOverlap = Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top);
                    return xOverlap <= .5 || yOverlap <= .5;
                  }));
                  const oddCenters = selectedRowBars.filter(item => item.phase % 2 === 1).map(item => (item.rect.top + item.rect.bottom) / 2);
                  const evenCenters = selectedRowBars.filter(item => item.phase % 2 === 0).map(item => (item.rect.top + item.rect.bottom) / 2);
                  return {
                    width:window.innerWidth,
                    guides:guides.length,
                    startError:Math.abs(guideRects[0].left - barRect.left),
                    endError:Math.abs(guideRects[1].left - (barRect.right - 1)),
                    topError:Math.abs(guideRects[0].top - bodyRect.top),
                    bottomError:Math.abs(guideRects[0].bottom - bodyRect.bottom),
                    headerClear:guideRects[0].top >= headRect.bottom - 1,
                    layerBehind:Number(getComputedStyle(layer).zIndex) < Number(getComputedStyle(bar).zIndex),
                    lanesClear,
                    fixedRowHeight:Math.round(selectedRow.getBoundingClientRect().height),
                    oddAligned:Math.max(...oddCenters) - Math.min(...oddCenters) <= 1,
                    evenAligned:Math.max(...evenCenters) - Math.min(...evenCenters) <= 1
                  };
                }
                """
            )
            assert mobile_chart_metrics["width"] == 390
            assert mobile_chart_metrics["guides"] == 2
            assert mobile_chart_metrics["startError"] <= 1
            assert mobile_chart_metrics["endError"] <= 1
            assert mobile_chart_metrics["topError"] <= 1
            assert mobile_chart_metrics["bottomError"] <= 1
            assert mobile_chart_metrics["headerClear"] is True
            assert mobile_chart_metrics["layerBehind"] is True
            assert mobile_chart_metrics["lanesClear"] is True
            assert mobile_chart_metrics["fixedRowHeight"] == 56
            assert mobile_chart_metrics["oddAligned"] is True
            assert mobile_chart_metrics["evenAligned"] is True
            if screenshot_dir:
                mobile_page.evaluate(
                    "document.querySelector('.bar[data-task-id=\"1\"][data-phase=\"4\"]').scrollIntoView({block:'center',inline:'center'})"
                )
                mobile_page.screenshot(path=str(screenshot_dir / "wave3-mobile.png"), full_page=False)
            mobile_context.close()

            wave_three_result = {
                "desktop_guides": desktop_chart_metrics["guides"],
                "desktop_lanes_clear": desktop_chart_metrics["lanesClear"],
                "mobile_guides": mobile_chart_metrics["guides"],
                "mobile_lanes_clear": mobile_chart_metrics["lanesClear"],
            }

            integrated_result = page.evaluate(
                """
                () => {
                  const site = ScheduleCore.normalizeScheduleState(JSON.parse(JSON.stringify(S)));
                  const task = site.tasks.find(item => item.id === 1);
                  for (let index = 1; index <= 5; index++) {
                    ScheduleCore.updateTaskPhase(task, index, {
                      sd: '2026-08-20', ed: '2026-08-20', mode: 'manual'
                    });
                  }
                  _extScheduleCache = [];
                  _igY = 2026;
                  _igM = 7;
                  sw('i');
                  _cloudSites = [site];
                  rIntegrated();
                  const calendar = document.querySelector('#ig-trade-1 .ig-cal-grid');
                  const day = Array.from(calendar.querySelectorAll('.ig-cal-day')).find(cell => {
                    const label = cell.querySelector('.ig-cal-dn');
                    return label && label.textContent === '20';
                  });
                  const bars = Array.from(day.querySelectorAll('.ig-cal-bar'));
                  const dayRect = day.getBoundingClientRect();
                  return {
                    bars: bars.length,
                    height: Math.round(dayRect.height),
                    contained: bars.every(bar => bar.getBoundingClientRect().bottom <= dayRect.bottom + 1),
                    startBoundaries: bars.filter(bar => bar.classList.contains('range-start') && getComputedStyle(bar).borderLeftWidth === '1px').length,
                    endBoundaries: bars.filter(bar => bar.classList.contains('range-end') && getComputedStyle(bar).borderRightWidth === '1px').length
                  };
                }
                """
            )
            assert integrated_result["bars"] == 5
            assert integrated_result["height"] >= 116
            assert integrated_result["contained"] is True
            assert integrated_result["startBoundaries"] == 5
            assert integrated_result["endBoundaries"] == 5

            page.locator("#tabs > #te").click()
            manual_group = page.get_by_role("group", name="간판실측 가능일 배치 방식")
            manual_group.get_by_role("button", name="수동").click()
            manual_group.locator("xpath=ancestor::tr").locator(".date-disp").click()
            page.locator('#tcalOv .tcal-dn[data-ds="2026-09-30"]').click()
            assert page.locator(".note-date-warning").count() == 1
            page.evaluate(
                """
                () => {
                  const cleaning = S.tasks.find(task => task.id === 14);
                  while (ScheduleCore.getTaskPhaseCount(cleaning) < 5) {
                    ScheduleCore.addTaskPhase(cleaning, {mode:'auto'});
                  }
                  for (let index = 1; index <= 5; index++) {
                    const ds = addD(S.ed, index - 5);
                    ScheduleCore.updateTaskPhase(cleaning, index, {sd:ds, ed:ds, mode:'auto'});
                  }
                }
                """
            )
            before_period_change = page.evaluate(
                """
                () => ({
                  manualNote: ScheduleCore.getNoteDate(S.notes.find(note => note.id === 4), S),
                  autoNote: ScheduleCore.getNoteDate(S.notes.find(note => note.id === 5), S),
                  manualPhase: ScheduleCore.getTaskPhase(S.tasks.find(task => task.id === 1), 4),
                  customPrimary: ScheduleCore.getTaskPhase(S.tasks.find(task => task.custom), 1),
                  cleaningRanges: ScheduleCore.getTaskRanges(S.tasks.find(task => task.id === 14))
                })
                """
            )
            page.locator('.cal-dn[data-ds="2026-08-10"]').click()
            page.locator('.cal-dn[data-ds="2026-09-20"]').click()
            after_period_change = page.evaluate(
                """
                () => ({
                  manualNote: ScheduleCore.getNoteDate(S.notes.find(note => note.id === 4), S),
                  autoNote: ScheduleCore.getNoteDate(S.notes.find(note => note.id === 5), S),
                  manualPhase: ScheduleCore.getTaskPhase(S.tasks.find(task => task.id === 1), 4),
                  customPrimary: ScheduleCore.getTaskPhase(S.tasks.find(task => task.custom), 1),
                  cleaningRanges: ScheduleCore.getTaskRanges(S.tasks.find(task => task.id === 14))
                })
                """
            )
            assert after_period_change["manualNote"] == before_period_change["manualNote"]
            assert after_period_change["autoNote"] != before_period_change["autoNote"]
            assert after_period_change["manualPhase"]["sd"] == before_period_change["manualPhase"]["sd"]
            assert after_period_change["manualPhase"]["ed"] == before_period_change["manualPhase"]["ed"]
            assert before_period_change["customPrimary"]["mode"] == "auto"
            assert after_period_change["customPrimary"]["sd"] == "2026-08-10"
            assert after_period_change["customPrimary"]["ed"] == "2026-08-16"
            assert len(after_period_change["cleaningRanges"]) == 5
            assert after_period_change["cleaningRanges"][-1]["ed"] == "2026-09-20"
            assert all(
                current["sd"] > previous["ed"]
                for previous, current in zip(
                    after_period_change["cleaningRanges"],
                    after_period_change["cleaningRanges"][1:],
                )
            )

            auto_schedule_result = page.evaluate(
                """
                () => {
                  const candidateIndex = S.tasks.findIndex(item => item.id === 6);
                  const candidateTask = S.tasks[candidateIndex];
                  const originalCandidate = JSON.parse(JSON.stringify(candidateTask));
                  const cleaningIndex = S.tasks.findIndex(item => item.id === 14);
                  const cleaningTask = S.tasks[cleaningIndex];
                  const originalCleaning = JSON.parse(JSON.stringify(cleaningTask));
                  const customIndex = S.tasks.findIndex(item => item.custom);
                  const originalCustom = JSON.parse(JSON.stringify(S.tasks[customIndex]));
                  while (ScheduleCore.getTaskPhaseCount(candidateTask) < 5) {
                    const phase = ScheduleCore.addTaskPhase(candidateTask, {mode:'auto'});
                    const ds = addD(S.sd, phase.index * 2);
                    ScheduleCore.updateTaskPhase(candidateTask, phase.index, {sd:ds,ed:ds,mode:'auto'});
                  }
                  while (ScheduleCore.getTaskPhaseCount(cleaningTask) < 5) {
                    const phase = ScheduleCore.addTaskPhase(cleaningTask, {mode:'auto'});
                    const ds = addD(S.sd, phase.index * 2);
                    ScheduleCore.updateTaskPhase(cleaningTask, phase.index, {
                      sd:ds, ed:addD(ds, phase.index === 5 ? 1 : 0), mode:'auto'
                    });
                  }
                  const settings = asGetSettings();
                  settings[6] = Object.assign({}, settings[6], {contractors:['AS A','AS B'],asOn:true});
                  const customTask = S.tasks.find(task => task.custom);
                  settings[customTask.id] = Object.assign({}, settings[customTask.id], {
                    contractors:['Custom A','Custom B'],asOn:true
                  });
                  asSaveSettings(settings);
                  candidateTask.contractors = ['AS A','AS B'];
                  customTask.contractors = ['Custom A','Custom B'];
                  asRunSchedule();
                  let candidate = _asResult.find(result => result.tid === 6);
                  const phase4 = asResultRanges(candidate).find(range => range.index === 4);
                  _cloudSites = [
                    {pn:'AS phase conflict',tasks:[{
                      id:6,name:'도장공사',desc:'',on:true,canSplit:true,custom:false,
                      sd:phase4.sd,ed:S.ed,scheduleMode:'manual',contractors:['AS A']
                    }]},
                    {pn:'AS custom conflict',tasks:[{
                      id:customTask.id + 1,name:'다른 사용자 공종',desc:'',on:true,canSplit:true,custom:true,
                      sd:S.sd,ed:S.ed,scheduleMode:'manual',contractors:['Custom A']
                    }]}
                  ];
                  asRunSchedule();
                  const base = _asResult.find(result => result.tid === 1);
                  candidate = _asResult.find(result => result.tid === 6);
                  const custom = _asResult.find(result => result.tid === S.tasks.find(task => task.custom).id);
                  const cleaning = _asResult.find(result => result.tid === 14);
                  const cleaningRanges = asResultRanges(cleaning);
                  const nonCleaningLatest = _asResult.filter(result => result.tid !== 14)
                    .flatMap(asResultRanges)
                    .reduce((latest, range) => !latest || range.ed > latest ? range.ed : latest, '');
                  const previewProbe = JSON.parse(JSON.stringify(candidate));
                  previewProbe.origRanges = asResultRanges(previewProbe).map(range => Object.assign({}, range));
                  previewProbe.origSd = previewProbe.sd;
                  previewProbe.origEd = previewProbe.ed;
                  previewProbe.origRanges.find(range => range.index === 4).sd = addD(
                    previewProbe.origRanges.find(range => range.index === 4).sd, -1
                  );
                  asShowStep2([previewProbe], S.ed);
                  const result = {
                    basePhases: asResultRanges(base).length,
                    candidatePhases: asResultRanges(candidate).length,
                    customPhases: asResultRanges(custom).length,
                    cleaningPhases: cleaningRanges.length,
                    cleaningSequential: cleaningRanges.every((range, index) =>
                      index === 0 || range.sd === addD(cleaningRanges[index - 1].ed, 1)),
                    cleaningAfterAll: cleaningRanges[0].sd >= nonCleaningLatest,
                    customCtor: custom.ctor,
                    secondaryChangeDetected: asRangesChanged(previewProbe),
                    secondaryIgnoreVisible: !!document.getElementById('asIgnoreCtrl_' + previewProbe.tid),
                    selectedCtor: candidate.ctor
                  };
                  _cloudSites = [];
                  S.tasks[candidateIndex] = originalCandidate;
                  S.tasks[cleaningIndex] = originalCleaning;
                  S.tasks[customIndex] = originalCustom;
                  return result;
                }
                """
            )
            assert auto_schedule_result == {
                "basePhases": 5,
                "candidatePhases": 5,
                "customPhases": 2,
                "cleaningPhases": 5,
                "cleaningSequential": True,
                "cleaningAfterAll": True,
                "customCtor": "Custom B",
                "secondaryChangeDetected": True,
                "secondaryIgnoreVisible": True,
                "selectedCtor": "AS B",
            }, auto_schedule_result

            gcal_result = page.evaluate(
                """
                async () => {
                  const task = JSON.parse(JSON.stringify(S.tasks.find(item => item.id === 1)));
                  const originalApiCall = _gcalApiCall;
                  const events = [];
                  _gcalApiCall = async (_method, _alias, _path, body) => {
                    events.push(body);
                    return {ok:true, status:200, json:async () => ({})};
                  };
                  try {
                    await new Promise(resolve => _gcalDoUpload({pn:'Wave2 QA',tasks:[task]}, 'detail', resolve));
                  } finally {
                    _gcalApiCall = originalApiCall;
                  }
                  return events.map(event => event.summary);
                }
                """
            )
            assert len(gcal_result) == 5
            assert any("(5차)" in summary for summary in gcal_result)

            gcal_simple_result = page.evaluate(
                """
                async () => {
                  const task = JSON.parse(JSON.stringify(S.tasks.find(item => item.id === 1)));
                  ScheduleCore.updateTaskPhase(task, 5, {
                    sd:'2026-10-01', ed:'2026-10-03', mode:'manual'
                  });
                  const originalApiCall = _gcalApiCall;
                  let event = null;
                  _gcalApiCall = async (_method, _alias, _path, body) => {
                    event = body;
                    return {ok:true, status:200, json:async () => ({})};
                  };
                  try {
                    await new Promise(resolve => _gcalDoUploadSimple({
                      pn:'Wave2 QA',sd:'2026-08-10',ed:'2026-09-20',tasks:[task]
                    }, 'simple', resolve));
                  } finally {
                    _gcalApiCall = originalApiCall;
                  }
                  return {start:event.start.date,end:event.end.date};
                }
                """
            )
            assert gcal_simple_result == {"start": "2026-08-10", "end": "2026-10-04"}

            page.locator("#tabs > #te").click()
            page.wait_for_timeout(950)
            page.locator('#pnchips .pnchip[data-pn="Wave2 Other"] .pnchip-body').click()
            page.locator('#pnchips .pnchip[data-pn="Wave2 QA"] .pnchip-body').click()
            reload_result = page.evaluate(
                f"""
                () => {{
                  const custom = S.tasks.find(task => task.id === {custom_id});
                  const phase4 = ScheduleCore.getTaskPhase(S.tasks.find(task => task.id === 1), 4);
                  return {{
                    phaseCount: ScheduleCore.getTaskPhaseCount(S.tasks.find(task => task.id === 1)),
                    phase4: {{name:phase4.name, sd:phase4.sd, ed:phase4.ed}},
                    customName: custom && custom.name,
                    customPhases: custom && ScheduleCore.getTaskPhaseCount(custom),
                    contractors: custom && custom.contractors,
                    manualNote: ScheduleCore.getNoteDate(S.notes.find(note => note.id === 4), S)
                  }};
                }}
                """
            )
            assert reload_result["phaseCount"] == 5
            assert reload_result["phase4"] == {"name": "가설 4차", "sd": "2026-08-19", "ed": "2026-08-20"}
            assert reload_result["customName"] == "보양공사"
            assert reload_result["customPhases"] == 2
            assert "QA 협력사" in reload_result["contractors"]
            assert reload_result["manualNote"] == "2026-09-30"

            phase_conflict_before = page.evaluate(
                """
                () => {
                  const task = S.tasks.find(item => item.id === 1);
                  task.contractors = ['차수 검증 업체'];
                  const otherTask = JSON.parse(JSON.stringify(task));
                  for (let index = 1; index <= 5; index++) {
                    ScheduleCore.updateTaskPhase(otherTask, index, {
                      sd: index === 4 ? '2026-08-19' : '2030-01-0' + index,
                      ed: index === 4 ? '2026-08-19' : '2030-01-0' + index,
                      mode: 'manual'
                    });
                  }
                  _cloudSites = [{pn:'차수 충돌 현장',tasks:[otherTask]}];
                  document.getElementById('ctorCheckOv').style.display = 'flex';
                  _buildCtorCheck();
                  const primary = ScheduleCore.getTaskPhase(task, 1);
                  const fourth = ScheduleCore.getTaskPhase(task, 4);
                  return {primary:primary.sd, fourth:fourth.sd};
                }
                """
            )
            phase_four_resolve = page.locator('#ctorCheckBody [id^="ccrow_1_p4_"] button').last
            phase_four_resolve.click()
            page.locator("#igConfirmOk").click()
            assert page.evaluate(
                """
                () => {
                  const task = S.tasks.find(item => item.id === 1);
                  return {
                    primary: ScheduleCore.getTaskPhase(task, 1).sd,
                    fourth: ScheduleCore.getTaskPhase(task, 4).sd,
                    fourthMode: ScheduleCore.getTaskPhase(task, 4).mode
                  };
                }
                """
            ) == {
                "primary": phase_conflict_before["primary"],
                "fourth": "2026-08-20",
                "fourthMode": "manual",
            }
            page.locator('#ctorCheckBody [id^="ccrow_1_p4_"] button').last.click()
            assert page.evaluate(
                "ScheduleCore.getTaskPhase(S.tasks.find(item => item.id === 1), 4).sd"
            ) == phase_conflict_before["fourth"]
            page.locator('#ctorCheckOv button', has_text="✕").click()

            reset_group = page.get_by_role("group", name="간판실측 가능일 배치 방식")
            reset_group.get_by_role("button", name="자동").click()
            assert page.evaluate("S.notes.find(note => note.id === 4).dateMode") == "auto"
            page.locator(f"#taskCard{custom_id} > .th2").click()
            page.locator(f'.delete-task-btn[data-task-id="{custom_id}"]').click()
            page.locator("#igConfirmOk").click()
            assert page.evaluate(f"S.tasks.some(task => task.id === {custom_id})") is False
            page.wait_for_timeout(950)
            page.locator('#pnchips .pnchip[data-pn="Wave2 Other"] .pnchip-body').click()
            page.locator('#pnchips .pnchip[data-pn="Wave2 QA"] .pnchip-body').click()
            assert page.evaluate(f"S.tasks.some(task => task.id === {custom_id})") is False

            wave_two_result = {
                "phase_count": reload_result["phaseCount"],
                "custom_phase_count": reload_result["customPhases"],
                "manual_note": reload_result["manualNote"],
                "integrated_bars": integrated_result["bars"],
                "gcal_events": len(gcal_result),
            }

            chart_task_result = run_chart_task_management(
                browser,
                origin,
                route_request,
                screenshot_dir,
                console_errors,
                page_errors,
                request_failures,
            )

            note_date_result = run_note_date_interactions(
                browser,
                origin,
                route_request,
                screenshot_dir,
                console_errors,
                page_errors,
                request_failures,
            )

            assert console_errors == [], console_errors
            assert page_errors == [], page_errors
            assert request_failures == [], request_failures
            assert unexpected_mutations == [], unexpected_mutations
            context.close()
            browser.close()

        result = {
            "period": {
                "confirmed": period_result["confirmed"],
                "start": period_result["sd"],
                "end": period_result["ed"],
                "auto_start": period_result["automatic"]["sd"],
                "manual_start": period_result["manual"]["sd"],
                "automatic_ranges_inside_period": all(item["inside"] for item in auto_range_matrix),
            },
            "pending_rename_preserved_other_site": autosave_result["b"]["marker"] == "B-concurrent",
            "delayed_unconfirm_preserved_other_site": autosave_result["b"]["marker"] == "B-concurrent",
            "no_op_bar_press_preserved_auto_mode": True,
            "failed_unconfirm_preserved_lock": True,
            "normalized_self_rename": normalized_rename["activeIdentity"],
            "failed_confirm_did_not_delete_cloud": confirm_failure_guard["deleteCalls"] == 0,
            "unicode_cloud_conflict_blocked": True,
            "master_cloud_rename_conflict_blocked": cloud_edit_guard["writes"] == 0,
            "first_save_round_trip": first_save_round_trip,
            "cloud_restore_round_trip": cloud_restore_round_trip,
            "wave_two": wave_two_result,
            "wave_three": wave_three_result,
            "chart_task_management": chart_task_result,
            "note_date_interactions": note_date_result,
            "intercepted_local_config_requests": intercepted_config_requests,
            "unexpected_network_mutations": len(unexpected_mutations),
            "console_errors": len(console_errors),
            "page_errors": len(page_errors),
            "request_failures": len(request_failures),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
