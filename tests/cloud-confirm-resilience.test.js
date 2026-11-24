'use strict';

/* 통합공정표(ig-ism) 확정 상태 유지 회귀 시험:
   - Firestore offline/WebChannel 1회 실패 시 발생하는 빈/부분 캐시 스냅샷(fromCache:true)이
     공유 현장 영역(#cloudChipsBody)을 숨기거나 로컬 확정 상태(confirmed:true)를 풀지 않는다.
   - 서버 확정 스냅샷(!fromCache)이 오면 기존에 잘못 풀린 본인 현장 확정도 복원하되,
     로컬에서 일정을 수정한 초안은 덮어쓰지 않고, 실제 클라우드 삭제는 정상 해제한다. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
const scheduleCoreCode = fs.readFileSync('schedule-core.js', 'utf8');

function extractFn(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  let start = -1;
  for (const marker of markers) {
    start = source.indexOf(marker);
    if (start >= 0) break;
  }
  assert.ok(start >= 0, `함수를 찾지 못했다: ${name}`);
  let braceStart = source.indexOf('{', start);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (ch === "'") { inSingle = true; continue; }
      if (ch === '"') { inDouble = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    } else if (inSingle) {
      if (ch === '\\') i++;
      else if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
    }
  }
  throw new Error(`함수 끝을 찾지 못했다: ${name}`);
}

function makeSiteState(pn, sd, ed, opts) {
  const o = opts || {};
  return {
    pn,
    sd,
    ed,
    author: o.author || 'whskadml0',
    confirmed: o.confirmed !== false,
    tasks: o.tasks || [
      { id: 1, name: '가설공사', on: true, sd, ed, contractors: o.contractors || [''] },
    ],
    notes: o.notes || [],
  };
}

function createHarness(options) {
  const opts = options || {};
  const lsStore = new Map();
  if (opts.recent) lsStore.set('cs_recent', JSON.stringify(opts.recent));

  const domElements = {
    cloudChipsWrap: { style: {} },
    cloudChipsBody: { style: { display: '' } },
    cloudChips: { innerHTML: '', querySelectorAll: () => [] },
    cloudArchiveWrap: { style: { display: '' } },
    cloudArchiveChips: { classList: { contains: () => false }, innerHTML: '', dataset: {}, querySelectorAll: () => [] },
    cloudArchiveCount: { textContent: '0' },
    editExportSites: { innerHTML: '' },
    ca: { firstChild: null, insertBefore() {} },
    'lock-banner': { style: { display: '' } },
  };

  let snapshotSuccess = null;
  let snapshotError = null;
  let serverGetResponse = opts.serverGetResponse || null;
  const deletedPending = [];
  const gcalAutoDeletes = [];
  const toasts = [];
  let rChipsCalls = 0;
  let rEditCalls = 0;

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Set,
    Map,
    Error,
    setTimeout,
    clearTimeout,
    window: {},
    localStorage: {
      getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
      setItem: (k, v) => lsStore.set(k, String(v)),
      removeItem: (k) => lsStore.delete(k),
    },
    document: {
      getElementById: (id) => domElements[id] || null,
      querySelector: () => null,
      createElement: () => ({ className: '', textContent: '', style: {} }),
    },
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(scheduleCoreCode, sandbox);

  const fnNames = [
    '_scheduleRestoreContentKey',
    '_restoreMyCloudSites',
    '_syncConfirmedWithCloud',
    '_handleCloudDeletion',
    '_reconcileLocalConfirmed',
    '_scheduleServerFallbackLoad',
    '_startCloudListener',
    'loadCloudSites',
    '_normalizeCloudContractors',
    'rSharedExportSites',
    '_activeSharedExportSites',
    'rCloudChips',
    'sanitizeKey',
  ];

  const preamble = `
    var RK = 'cs_recent';
    var _fbReady = true;
    var _cloudSites = [];
    var _cloudInventoryReady = false;
    var _cloudServerSynced = false;
    var _cloudListenFallbackAt = 0;
    var _cloudLoadPromise = null;
    var _cloudSnapshotUnsubscribe = null;
    var _cloudView = null;
    var _cloudEditing = null;
    var _confirmGrace = {};
    var _masterMode = false;
    var _hubDeep = {};
    var _gcalEnabled = true;
    var _gcalReady = true;
    var IS_RO = false;
    var S = ${JSON.stringify(makeSiteState(opts.activePn || '', '2026-11-25', '2026-12-20', { confirmed: false }))};
    function getRecent() { try { return JSON.parse(localStorage.getItem(RK) || '[]'); } catch(e) { return []; } }
    function setRecent(arr) { localStorage.setItem(RK, JSON.stringify(arr)); }
    function getDeviceName() { return ${JSON.stringify(opts.deviceName || 'whskadml0')}; }
    function today() { return '2026-11-24'; }
    function esc(s) { return String(s == null ? '' : s); }
    function rChips() { __rChipsCalls++; }
    function rEdit() { __rEditCalls++; }
    function _updLockOverlay() {}
    function toast(m) { __toasts.push(m); }
    function _gcalAddPendingDelete(pn) { __deletedPending.push(pn); }
    function _gcalAutoDelete(pn) { __gcalAutoDeletes.push(pn); }
    function _gcalCatchupSync() {}
    var _db = {
      collection: function() {
        return {
          onSnapshot: function(onNext, onErr) {
            __setHandlers(onNext, onErr);
            return function() {};
          },
          get: async function() {
            return typeof __serverGet === 'function' ? __serverGet() : { docs: [] };
          }
        };
      }
    };
  `;

  sandbox.__rChipsCalls = 0;
  sandbox.__rEditCalls = 0;
  sandbox.__toasts = toasts;
  sandbox.__deletedPending = deletedPending;
  sandbox.__gcalAutoDeletes = gcalAutoDeletes;
  sandbox.__setHandlers = (next, err) => { snapshotSuccess = next; snapshotError = err; };
  sandbox.__serverGet = () => {
    if (typeof serverGetResponse === 'function') return serverGetResponse();
    return serverGetResponse || { docs: [] };
  };

  const extracted = fnNames.map((name) => extractFn(html, name)).join('\n');
  vm.runInContext(preamble + '\n' + extracted, sandbox);

  return {
    sandbox,
    domElements,
    lsStore,
    deletedPending,
    gcalAutoDeletes,
    toasts,
    getRecent: () => JSON.parse(lsStore.get('cs_recent') || '[]'),
    setServerGetResponse: (r) => { serverGetResponse = r; },
    emitSnapshot(docs, { fromCache = false, changes = [] } = {}) {
      snapshotSuccess({
        metadata: { fromCache },
        docs: docs.map((d) => ({ data: () => JSON.parse(JSON.stringify(d)) })),
        docChanges: () => changes.map((c) => ({
          type: c.type,
          doc: { id: c.id || c.pn, data: () => JSON.parse(JSON.stringify(c.data || { pn: c.pn })) },
        })),
      });
    },
    rChipsCalls: () => sandbox.__rChipsCalls,
    rEditCalls: () => sandbox.__rEditCalls,
  };
}

test('initFirebase 가 모바일 WebChannel 끊김 대비 experimentalAutoDetectLongPolling 을 켠다', () => {
  const initSrc = extractFn(html, 'initFirebase');
  assert.match(initSrc, /experimentalAutoDetectLongPolling:\s*true/);
  assert.match(initSrc, /merge:\s*true/);
});

test('빈 캐시 스냅샷(fromCache:true, docs:[])이 와도 공유현장 UI 를 숨기지 않고 로컬 확정을 유지한다', () => {
  const stateA = makeSiteState('서울곱창 일산점', '2026-11-25', '2026-12-20');
  const h = createHarness({
    deviceName: 'whskadml0',
    activePn: '서울곱창 일산점',
    recent: [{
      pn: '서울곱창 일산점', sd: '2026-11-25', ed: '2026-12-20',
      savedAt: '2026-11-24 16:04', author: 'whskadml0', confirmed: true,
      snap: JSON.stringify(stateA),
    }],
    serverGetResponse: () => { throw new Error('offline'); },
  });

  h.sandbox._startCloudListener();
  /* Firestore SDK 가 1회 WebChannel 오류 후 즉시 발행하는 빈 cache 스냅샷 재현 */
  h.emitSnapshot([], { fromCache: true });

  assert.equal(h.getRecent()[0].confirmed, true, '로컬 확정이 해제되면 안 된다');
  assert.equal(h.deletedPending.length, 0, '캘린더 삭제 대기열에 올라가면 안 된다');
  assert.equal(h.sandbox._cloudInventoryReady, false, '빈 캐시는 준비 완료로 보지 않는다');
  assert.notEqual(h.domElements.cloudChipsBody.style.display, 'none', '공유 현장 본문을 숨기면 안 된다');
  assert.match(h.domElements.cloudChips.innerHTML, /Firebase 연결 대기 중/);
});

test('초기 서버 동기화 전 부분 캐시 스냅샷(fromCache:true)이나 직접 빈 대조 호출은 기존 확정을 풀지 않는다', () => {
  const h = createHarness({
    deviceName: 'whskadml0',
    recent: [
      { pn: '현장 A', sd: '2026-11-25', ed: '2026-12-20', author: 'whskadml0', confirmed: true, snap: JSON.stringify(makeSiteState('현장 A', '2026-11-25', '2026-12-20')) },
      { pn: '현장 B', sd: '2026-11-26', ed: '2026-12-21', author: 'whskadml0', confirmed: true, snap: JSON.stringify(makeSiteState('현장 B', '2026-11-26', '2026-12-21')) },
    ],
  });

  h.sandbox._startCloudListener();
  h.emitSnapshot([makeSiteState('현장 A', '2026-11-25', '2026-12-20')], { fromCache: true });
  assert.equal(h.getRecent().every((x) => x.confirmed === true), true);

  /* _reconcileLocalConfirmed 직접 호출도 빈 _cloudSites 에서는 무동작 */
  h.sandbox._cloudInventoryReady = true;
  h.sandbox._cloudSites = [];
  h.sandbox._reconcileLocalConfirmed();
  assert.equal(h.getRecent().every((x) => x.confirmed === true), true);
});

test('캐시 상태 removed 이벤트는 무시하고, 서버 스냅샷(!fromCache)에서의 실제 삭제만 로컬 확정을 해제한다', () => {
  const siteKeep = makeSiteState('유지 현장', '2026-11-25', '2026-12-20');
  const siteRemoved = makeSiteState('마스터 삭제 현장', '2026-11-26', '2026-12-21');
  const remoteSite = makeSiteState('타직원 현장', '2026-10-01', '2026-10-15', { author: 'shinnize' });
  const h = createHarness({
    deviceName: 'whskadml0',
    recent: [
      { pn: '유지 현장', sd: '2026-11-25', ed: '2026-12-20', author: 'whskadml0', confirmed: true, snap: JSON.stringify(siteKeep) },
      { pn: '마스터 삭제 현장', sd: '2026-11-26', ed: '2026-12-21', author: 'whskadml0', confirmed: true, snap: JSON.stringify(siteRemoved) },
    ],
  });

  h.sandbox._startCloudListener();
  /* 1) 최초 서버 스냅샷 수신 (둘 다 존재) */
  h.emitSnapshot([siteKeep, siteRemoved, remoteSite], { fromCache: false });
  assert.equal(h.sandbox._cloudInventoryReady, true);
  assert.equal(h.getRecent().every((x) => x.confirmed === true), true);
  assert.equal(h.domElements.cloudChipsBody.style.display, '');

  /* 2) 오프라인 캐시에서 removed 가 와도 무시 */
  h.emitSnapshot([siteKeep, remoteSite], {
    fromCache: true,
    changes: [{ type: 'removed', pn: '유지 현장', data: siteKeep }],
  });
  assert.equal(h.getRecent().find((x) => x.pn === '유지 현장').confirmed, true);

  /* 3) 실제 서버 스냅샷에서 '마스터 삭제 현장'이 사라지면 정상 해제 */
  h.emitSnapshot([siteKeep, remoteSite], { fromCache: false });
  assert.equal(h.getRecent().find((x) => x.pn === '유지 현장').confirmed, true);
  assert.equal(h.getRecent().find((x) => x.pn === '마스터 삭제 현장').confirmed, false);
  assert.deepEqual(h.deletedPending, ['마스터 삭제 현장']);
});

test('이전 장애로 로컬 confirmed 가 false 로 풀렸더라도 서버에 동일본이 있으면 자동 복원하고, 로컬 수정본은 건드리지 않는다', () => {
  const cloudSame = makeSiteState('서울곱창 일산점', '2026-11-25', '2026-12-20', { contractors: ['목공A'] });
  const localSameCopy = makeSiteState('서울곱창 일산점', '2026-11-25', '2026-12-20', {
    confirmed: false,
    contractors: ['목공A', '', ''], /* saveProject 형식 빈 슬롯 포함 */
  });
  const cloudOlder = makeSiteState('정돈 안양점', '2026-11-06', '2026-12-06');
  const localModifiedDraft = makeSiteState('정돈 안양점', '2026-11-06', '2026-12-10', { confirmed: false });

  const h = createHarness({
    deviceName: 'whskadml0',
    activePn: '서울곱창 일산점',
    recent: [
      { pn: '서울곱창 일산점', sd: '2026-11-25', ed: '2026-12-20', savedAt: '2026-11-24 16:04', author: 'whskadml0', confirmed: false, snap: JSON.stringify(localSameCopy) },
      { pn: '정돈 안양점', sd: '2026-11-06', ed: '2026-12-10', savedAt: '2026-11-24 16:05', author: 'whskadml0', confirmed: false, snap: JSON.stringify(localModifiedDraft) },
    ],
  });

  h.sandbox._startCloudListener();
  h.emitSnapshot([cloudSame, cloudOlder], { fromCache: false });

  const rec = h.getRecent();
  assert.equal(rec.find((x) => x.pn === '서울곱창 일산점').confirmed, true, '클라우드 동일본은 자동 확정 복원');
  assert.equal(h.sandbox.IS_RO, true, '활성 현장 잠금 상태도 함께 복원');
  assert.equal(rec.find((x) => x.pn === '정돈 안양점').confirmed, false, '일정이 다른 로컬 수정본은 유지');
});

test('loadCloudSites 도 fromCache 빈 응답을 성공으로 취급하지 않고 기존 확정을 보호한다', async () => {
  const stateA = makeSiteState('코다리밥도둑 김포운양점', '2026-12-05', '2026-12-20');
  const h = createHarness({
    deviceName: 'whskadml0',
    recent: [{
      pn: '코다리밥도둑 김포운양점', sd: '2026-12-05', ed: '2026-12-20',
      author: 'whskadml0', confirmed: true, snap: JSON.stringify(stateA),
    }],
    serverGetResponse: { metadata: { fromCache: true }, docs: [] },
  });

  const ok = await h.sandbox.loadCloudSites(true);
  assert.equal(ok, false);
  assert.equal(h.sandbox._cloudInventoryReady, false);
  assert.equal(h.getRecent()[0].confirmed, true);
});
