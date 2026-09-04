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
