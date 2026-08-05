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
