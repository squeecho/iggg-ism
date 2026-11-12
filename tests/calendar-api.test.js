'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const calendarApi = require('../api/calendar.js');

test('Firestore REST typed values become the existing schedule snapshot shape', () => {
  const document = calendarApi._firestoreDocument({
    name: 'projects/iggg-schedule/databases/(default)/documents/sites/%EC%84%B1%EC%88%98_%EA%B3%B3%EA%B0%84',
    fields: {
      pn: { stringValue: '성수 곳간' },
      confirmed: { booleanValue: true },
      revision: { integerValue: '7' },
      tasks: {
        arrayValue: {
          values: [{
            mapValue: {
              fields: {
                id: { integerValue: '4' },
                name: { stringValue: '목공사' },
                on: { booleanValue: true }
              }
            }
          }]
        }
      }
    }
  });
  assert.equal(document.siteKey, '성수_곳간');
  assert.deepEqual(document.snapshot, {
    pn: '성수 곳간',
    confirmed: true,
    revision: 7,
    tasks: [{ id: 4, name: '목공사', on: true }]
  });
});

test('scheduler bypass requires a non-empty exact secret and cannot pass by length alone', () => {
  const previous = process.env.ISM_CALENDAR_CRON_SECRET;
  try {
    process.env.ISM_CALENDAR_CRON_SECRET = 'correct-secret';
    assert.equal(calendarApi.isSchedulerRequest({ headers: {} }), false);
    assert.equal(calendarApi.isSchedulerRequest({ headers: { 'x-ism-calendar-secret': 'wrong--secret' } }), false);
    assert.equal(calendarApi.isSchedulerRequest({ headers: { 'x-ism-calendar-secret': 'correct-secret' } }), true);
    delete process.env.ISM_CALENDAR_CRON_SECRET;
    assert.equal(calendarApi.isSchedulerRequest({ headers: { 'x-ism-calendar-secret': '' } }), false);
  } finally {
    if (previous == null) delete process.env.ISM_CALENDAR_CRON_SECRET;
    else process.env.ISM_CALENDAR_CRON_SECRET = previous;
  }
});

test('only the scheduler can apply while an authenticated browser is limited to dry run', () => {
  assert.deepEqual(calendarApi.reconcileRequestMode(true, {}), { allowed: true, dryRun: false });
  assert.deepEqual(calendarApi.reconcileRequestMode(true, { dryRun: true }), { allowed: true, dryRun: true });
  assert.deepEqual(calendarApi.reconcileRequestMode(false, { dryRun: true }), { allowed: true, dryRun: true });
  assert.deepEqual(calendarApi.reconcileRequestMode(false, {}), { allowed: false, dryRun: true });
});

test('server-managed UI status requires complete distinct calendars and scheduler secret', () => {
  const keys = [
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GCAL_ID_DETAIL',
    'GCAL_ID_SIMPLE', 'ISM_CALENDAR_CRON_SECRET'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'calendar@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'private';
    process.env.GCAL_ID_DETAIL = 'detail';
    process.env.GCAL_ID_SIMPLE = 'simple';
    delete process.env.ISM_CALENDAR_CRON_SECRET;
    assert.equal(calendarApi.calendarServerConfig().configured, false);
    process.env.ISM_CALENDAR_CRON_SECRET = 'secret';
    assert.equal(calendarApi.calendarServerConfig().configured, true);
    process.env.GCAL_ID_SIMPLE = 'detail';
    assert.equal(calendarApi.calendarServerConfig().configured, false);
  } finally {
    keys.forEach((key) => {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    });
  }
});

test('global request budget shortens page calls and fails before there is no safe time left', () => {
  const now = Date.now();
  assert.equal(calendarApi._deadlineTimeout(now + 5000, 9000) <= 4250, true);
  assert.throws(
    () => calendarApi._deadlineTimeout(now + 500, 9000),
    (error) => error.code === 'CALENDAR_SYNC_DEADLINE'
  );
});

test('external request wall-clock deadline fires even without an idle-timeout event', async () => {
  class FakeRequest extends EventEmitter {
    destroy(error) {
      this.error = error;
      this.emit('close');
    }
  }
  const request = new FakeRequest();
  calendarApi._armRequestDeadline(request, 10, 'absolute deadline');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(request.error && request.error.code, 'ETIMEDOUT');
  assert.equal(request.error && request.error.message, 'absolute deadline');
});

test('reconcile failure diagnostics expose only aggregate operation and status counts', () => {
  const summary = calendarApi.reconcileFailureSummary({
    code: 'CALENDAR_SYNC_UPSERT_FAILED',
    phase: 'upsert',
    result: {
      mode: 'detail',
      planned: { create: 3, update: 0, delete: 2, unchanged: 1 },
      applied: { create: 1, update: 0, delete: 0, unchanged: 1 },
      retries: 8,
      failures: [
        { operation: 'create', status: 403, eventId: 'private-id', message: 'private body' },
        { operation: 'create', status: 403, eventId: 'private-id-2', message: 'private body 2' },
      ],
    },
  });
  assert.deepEqual(summary.statusCounts, { 403: 2 });
  assert.deepEqual(summary.operationCounts, { create: 2 });
  assert.equal(summary.failureCount, 2);
  assert.equal(JSON.stringify(summary).includes('private-id'), false);
  assert.equal(JSON.stringify(summary).includes('private body'), false);
});

/* ── 보안 감사 2026-11-12 #2: ICS 구독 피드는 주소 안 비밀 토큰으로만 열린다 ── */
function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function callHandler(req) {
  const res = fakeRes();
  await calendarApi(Object.assign({ headers: {}, query: {} }, req), res);
  return res;
}

function withEnv(values, fn) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => {
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  });
  const restore = () => keys.forEach((key) => {
    if (previous[key] == null) delete process.env[key];
    else process.env[key] = previous[key];
  });
  return Promise.resolve().then(fn).finally(restore);
}

const FEED_TOKEN = 'a3f9c2e17b4d58e6a0f1c9b2d7e4a6c8';
/* 토큰이 맞으면 게이트를 지나 서비스 계정 설정 점검까지 간다(여기선 env 를
   비워 500 'Service account not configured' 로 통과 여부를 확인한다). */
const NO_SERVICE_ACCOUNT = { GOOGLE_SERVICE_ACCOUNT_EMAIL: null, GOOGLE_PRIVATE_KEY: null };

test('ICS feed is closed (404) when ICS_FEED_TOKEN is not configured, even with a token', () =>
  withEnv(Object.assign({ ICS_FEED_TOKEN: null }, NO_SERVICE_ACCOUNT), async () => {
    for (const url of [
      '/api/calendar?action=ics&cal=detail',
      '/api/calendar?action=ics&cal=detail&k=' + FEED_TOKEN,
      '/api/calendar?action=ics&cal=simple&f=' + FEED_TOKEN + '.ics',
    ]) {
      const res = await callHandler({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(String(res.body).includes('BEGIN:VCALENDAR'), false);
    }
  }));

test('ICS feed rejects missing, wrong, prefix and suffix-less tokens with the same 404', () =>
  withEnv(Object.assign({ ICS_FEED_TOKEN: FEED_TOKEN }, NO_SERVICE_ACCOUNT), async () => {
    for (const url of [
      '/api/calendar?action=ics&cal=detail',                       /* 옛 /calendar.ics 가 가던 곳 */
      '/api/calendar?action=ics&cal=detail&k=',
      '/api/calendar?action=ics&cal=detail&k=wrong-token',
      '/api/calendar?action=ics&cal=detail&k=' + FEED_TOKEN.slice(0, -1),
      '/api/calendar?action=ics&cal=detail&k=' + FEED_TOKEN + 'x',
      '/api/calendar?action=ics&cal=detail&f=' + FEED_TOKEN,       /* .ics 없는 경로형 */
      '/api/calendar?action=ics&cal=detail&f=wrong.ics',
      '/api/calendar?action=ics&cal=simple&f=.ics',
    ]) {
      const res = await callHandler({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.body, 'Not found', url);
    }
  }));

test('ICS feed passes the gate with the right token in path or query form', () =>
  withEnv(Object.assign({ ICS_FEED_TOKEN: FEED_TOKEN }, NO_SERVICE_ACCOUNT), async () => {
    for (const url of [
      '/api/calendar?action=ics&cal=detail&f=' + FEED_TOKEN + '.ics',
      '/api/calendar?action=ics&cal=simple&f=' + FEED_TOKEN + '.ics',
      '/api/calendar?action=ics&cal=detail&k=' + FEED_TOKEN,
    ]) {
      const res = await callHandler({ method: 'GET', url });
      assert.equal(res.statusCode, 500, url);
      assert.equal(res.body, 'Service account not configured', url);
    }
  }));

test('ICS token helpers: path form needs .ics suffix, empty env never matches', () =>
  withEnv({ ICS_FEED_TOKEN: FEED_TOKEN }, () => {
    assert.equal(calendarApi.icsTokenFromQuery({ f: FEED_TOKEN + '.ics' }), FEED_TOKEN);
    assert.equal(calendarApi.icsTokenFromQuery({ f: FEED_TOKEN }), '');
    assert.equal(calendarApi.icsTokenFromQuery({ k: FEED_TOKEN }), FEED_TOKEN);
    assert.equal(calendarApi.icsFeedTokenOk(FEED_TOKEN), true);
    assert.equal(calendarApi.icsFeedTokenOk(''), false);
    assert.deepEqual(calendarApi.icsFeedPaths(), {
      detail: '/calendar/' + FEED_TOKEN + '.ics',
      simple: '/calendar-simple/' + FEED_TOKEN + '.ics',
    });
    delete process.env.ICS_FEED_TOKEN;
    assert.equal(calendarApi.icsFeedTokenOk(''), false);
    assert.equal(calendarApi.icsFeedTokenOk(FEED_TOKEN), false);
    assert.equal(calendarApi.icsFeedPaths(), null);
  }));

test('ics-url action is behind the staff gate: no credential gets 401 and no token', () =>
  withEnv({ ICS_FEED_TOKEN: FEED_TOKEN }, async () => {
    const res = await callHandler({
      method: 'POST',
      url: '/api/calendar',
      headers: { origin: 'https://ism.igggstudio.com' },
      body: { action: 'ics-url' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['x-auth-denied'], '1');
    assert.equal(JSON.stringify(res.body).includes(FEED_TOKEN), false);

    const foreign = await callHandler({
      method: 'POST',
      url: '/api/calendar',
      headers: { origin: 'https://evil.example' },
      body: { action: 'ics-url' },
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal(JSON.stringify(foreign.body).includes(FEED_TOKEN), false);
  }));

test('vercel.json no longer routes the legacy public ICS addresses', () => {
  const config = require('../vercel.json');
  const sources = config.rewrites.map((rewrite) => rewrite.source);
  assert.equal(sources.includes('/calendar.ics'), false);
  assert.equal(sources.includes('/calendar-simple.ics'), false);
  const detail = config.rewrites.find((rewrite) => rewrite.source === '/calendar/:file');
  const simple = config.rewrites.find((rewrite) => rewrite.source === '/calendar-simple/:file');
  assert.equal(detail.destination, '/api/calendar?action=ics&cal=detail&f=:file');
  assert.equal(simple.destination, '/api/calendar?action=ics&cal=simple&f=:file');
});
