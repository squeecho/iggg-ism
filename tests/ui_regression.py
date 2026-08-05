import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format, *args):
        pass


def run():
    handler = partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"

    console_errors = []
    page_errors = []
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
                    intercepted_config_requests += 1
                    route.fulfill(
                        status=200,
                        content_type="application/json",
                        body=json.dumps({"detailCalId": "qa-detail", "simpleCalId": "qa-simple"}),
                    )
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
                    contained: bars.every(bar => bar.getBoundingClientRect().bottom <= dayRect.bottom + 1)
                  };
                }
                """
            )
            assert integrated_result["bars"] == 5
            assert integrated_result["height"] >= 116
            assert integrated_result["contained"] is True

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

            assert console_errors == [], console_errors
            assert page_errors == [], page_errors
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
            "intercepted_local_config_requests": intercepted_config_requests,
            "unexpected_network_mutations": len(unexpected_mutations),
            "console_errors": len(console_errors),
            "page_errors": len(page_errors),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    run()
