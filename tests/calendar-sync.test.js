'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA,
  CalendarSyncError,
  buildDesiredEvents,
  isStrictDate,
  eventNeedsUpdate,
  reconcileCalendar,
  reconcileAll
} = require('../calendar-sync.js');

function site(overrides) {
  return {
    siteKey: 'site-seongsu',
    snapshot: Object.assign({
      pn: '성수 곳간',
      confirmed: true,
      sd: '2026-09-01',
      ed: '2026-09-30',
      tasks: [
        {
          id: 1,
          name: '가설공사',
          on: true,
          sd: '2026-09-02',
          ed: '2026-09-04',
          desc: '보양',
          contractors: ['가설 협력사']
        },
        {
          id: 4,
          name: '목공사',
          on: true,
          sd: '2026-09-07',
          ed: '2026-09-10',
          split: true,
          name2: '목공사',
          sd2: '2026-09-14',
          ed2: '2026-09-16',
          desc2: '마감',
          contractors: []
        },
        { id: 2, name: '철거공사', on: false, sd: '2026-09-01', ed: '2026-09-01' }
      ]
    }, overrides || {})
  };
}

function managedLegacy(id, pn) {
  return {
    id,
    summary: pn,
    extendedProperties: { private: { src: 'iggg-ism', pn } }
  };
}

function adapters(existing, behavior) {
  const calls = { list: 0, create: [], update: [], delete: [] };
  const custom = behavior || {};
  return {
    calls,
    listManagedEvents: async () => {
      calls.list += 1;
      return { status: 200, items: existing };
    },
    createEvent: async (event) => {
      calls.create.push(event.id);
      return custom.create ? custom.create(event, calls) : { status: 200 };
    },
    updateEvent: async (id, event) => {
      calls.update.push(id);
      return custom.update ? custom.update(id, event, calls) : { status: 200 };
    },
    deleteEvent: async (id) => {
      calls.delete.push(id);
      return custom.delete ? custom.delete(id, calls) : { status: 204 };
    }
  };
}

test('desired events are deterministic, stable, tagged, and preserve existing detail/simple semantics', () => {
  const input = [site()];
  const first = buildDesiredEvents(input, 'detail');
  const second = buildDesiredEvents(JSON.parse(JSON.stringify(input)), 'detail');
  assert.deepEqual(second, first);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((event) => event.id)).size, 3);
  first.forEach((event) => {
    assert.match(event.id, /^[0-9a-v]{5,1024}$/);
    assert.equal(event.extendedProperties.private.src, 'iggg-ism');
    assert.equal(event.extendedProperties.private.schema, SCHEMA);
    assert.equal(event.extendedProperties.private.siteKey, 'site-seongsu');
    assert.equal(event.extendedProperties.private.mode, 'detail');
    assert.equal(event.status, 'confirmed');
    assert.equal(event.start.date <= event.end.date, true);
  });
  const phases = first.slice().sort((a, b) => a.start.date.localeCompare(b.start.date));
  assert.equal(phases[0].summary, '성수 | 가설 | 가설 협력사');
  assert.equal(phases[0].description, '성수 곳간 공사 일정\n공종: 가설공사\n설명: 보양\n업체: 가설 협력사');
  assert.equal(phases[0].end.date, '2026-09-05');
  assert.equal(phases[1].summary, '성수 | 목공 (1차)');
  assert.equal(phases[2].summary, '성수 | 목공 (2차)');

  const simple = buildDesiredEvents(input, 'simple');
  assert.equal(simple.length, 1);
  assert.equal(simple[0].summary, '성수 곳간');
  assert.equal(simple[0].description, '성수 곳간 공사 전체 기간');
  assert.deepEqual(simple[0].start, { date: '2026-09-01' });
  assert.deepEqual(simple[0].end, { date: '2026-10-01' });
  assert.equal(simple[0].extendedProperties.private.mode, 'simple');
  assert.notEqual(simple[0].id, first[0].id);
});

test('unchanged managed events are skipped exactly', async () => {
  const desired = buildDesiredEvents([site()], 'detail');
  const io = adapters(desired.map((event) => Object.assign({ etag: 'ignored' }, event)));
  const result = await reconcileCalendar(Object.assign({ sites: [site()], mode: 'detail' }, io));
  assert.equal(result.ok, true);
  assert.deepEqual(result.planned, { create: 0, update: 0, delete: 0, unchanged: 3 });
  assert.deepEqual(result.applied, { create: 0, update: 0, delete: 0, unchanged: 3 });
  assert.deepEqual(io.calls, { list: 1, create: [], update: [], delete: [] });
  assert.equal(eventNeedsUpdate(desired[0], desired[0]), false);
});

test('a partial upsert failure prevents every stale delete', async () => {
  const old = managedLegacy('old-event', '지워야 할 현장');
  let count = 0;
  const io = adapters([old], {
    create: async () => {
      count += 1;
      if (count === 2) return { status: 400 };
      return { status: 200 };
    }
  });
  await assert.rejects(
    reconcileCalendar(Object.assign({ sites: [site()], mode: 'detail', concurrency: 1 }, io)),
    (error) => {
      assert.equal(error instanceof CalendarSyncError, true);
      assert.equal(error.code, 'CALENDAR_SYNC_UPSERT_FAILED');
      assert.equal(error.phase, 'upsert');
      assert.equal(error.result.failures.length, 1);
      return true;
    }
  );
  assert.deepEqual(io.calls.delete, []);
});

test('upserts honor bounded concurrency and every delete starts after every upsert settles', async () => {
  const events = [];
  let active = 0;
  let peak = 0;
  let completed = 0;
  const io = adapters([managedLegacy('legacy', '이전 현장')], {
    create: async (event) => {
      active += 1;
      peak = Math.max(peak, active);
      events.push('create-start:' + event.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      completed += 1;
      active -= 1;
      events.push('create-end:' + event.id);
      return { status: 200 };
    },
    delete: async (id) => {
      assert.equal(completed, 3);
      events.push('delete:' + id);
      return { status: 204 };
    }
  });
  await reconcileCalendar(Object.assign({ sites: [site()], mode: 'detail', concurrency: 2 }, io));
  assert.equal(peak, 2);
  assert.equal(events.findIndex((entry) => entry.startsWith('delete:')) >
    events.map((entry, index) => entry.startsWith('create-end:') ? index : -1).sort((a, b) => b - a)[0], true);
});

test('a create 409 race is recovered with update of the deterministic id', async () => {
  let restored = null;
  const io = adapters([], {
    create: async () => ({ status: 409 }),
    update: async (_id, event) => {
      restored = event;
      return { status: 200 };
    }
  });
  const result = await reconcileCalendar(Object.assign({ sites: [site()], mode: 'simple' }, io));
  assert.equal(result.ok, true);
  assert.equal(io.calls.create.length, 1);
  assert.deepEqual(io.calls.update, io.calls.create);
  assert.equal(restored.status, 'confirmed');
  assert.deepEqual(result.applied, { create: 0, update: 1, delete: 0, unchanged: 0 });
});

test('manual events are preserved while legacy and stale managed events are deleted after upsert', async () => {
  const manual = { id: 'manual', summary: '사람이 쓴 일정' };
  const legacy = managedLegacy('legacy', '성수 곳간');
  const stale = managedLegacy('stale', '종료 현장');
  const io = adapters([manual, legacy, stale]);
  const result = await reconcileCalendar(Object.assign({ sites: [site()], mode: 'simple' }, io));
  assert.equal(result.preservedManual, 1);
  assert.equal(result.planned.create, 1);
  assert.equal(result.planned.delete, 2);
  assert.deepEqual(io.calls.delete.sort(), ['legacy', 'stale']);
  assert.equal(io.calls.delete.includes('manual'), false);
});

test('unknown managed schema or wrong mode fails before every mutation and is preserved', async () => {
  const unknown = {
    id: 'future-event',
    extendedProperties: {
      private: { src: 'iggg-ism', schema: 'iggg-ism/calendar-sync-v2', mode: 'detail', pn: '미래 현장' }
    }
  };
  const io = adapters([unknown]);
  await assert.rejects(
    reconcileCalendar(Object.assign({ sites: [site()], mode: 'detail' }, io)),
    (error) => {
      assert.equal(error.code, 'CALENDAR_SYNC_UNKNOWN_OWNERSHIP');
      assert.equal(error.result.preservedUnknown, 1);
      return true;
    }
  );
  assert.deepEqual(io.calls.create, []);
  assert.deepEqual(io.calls.update, []);
  assert.deepEqual(io.calls.delete, []);
});

test('429 and 5xx operations retry with bounded exponential delays', async () => {
  const waits = [];
  let createAttempts = 0;
  const io = adapters([], {
    create: async () => {
      createAttempts += 1;
      if (createAttempts === 1) return { status: 429 };
      if (createAttempts === 2) return { status: 503 };
      return { status: 200 };
    }
  });
  const result = await reconcileCalendar(Object.assign({
    sites: [site()],
    mode: 'simple',
    maxAttempts: 4,
    baseDelayMs: 5,
    sleep: async (delay) => { waits.push(delay); }
  }, io));
  assert.equal(result.retries, 2);
  assert.equal(createAttempts, 3);
  assert.deepEqual(waits, [5, 10]);
});

test('network timeout and Google quota 403 retry but permission 403 does not', async () => {
  const waits = [];
  let attempts = 0;
  const quota = adapters([], {
    create: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } };
      }
      if (attempts === 2) {
        const error = new Error('socket timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return { status: 200 };
    }
  });
  const ok = await reconcileCalendar(Object.assign({
    sites: [site()], mode: 'simple', maxAttempts: 4, baseDelayMs: 1,
    sleep: async (delay) => waits.push(delay)
  }, quota));
  assert.equal(ok.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1, 2]);

  const denied = adapters([], { create: async () => ({
    status: 403,
    body: { error: { errors: [{ reason: 'forbidden' }] } }
  }) });
  await assert.rejects(
    reconcileCalendar(Object.assign({ sites: [site()], mode: 'simple' }, denied)),
    (error) => error.code === 'CALENDAR_SYNC_UPSERT_FAILED'
  );
  assert.equal(denied.calls.create.length, 1);
});

test('deletion failure is structured and 404/410 deletes are idempotent success', async () => {
  const legacy404 = managedLegacy('legacy-404', '지워진 일정');
  const legacyFail = managedLegacy('legacy-fail', '삭제 실패');
  const io = adapters([legacy404, legacyFail], {
    delete: async (id) => id === 'legacy-404' ? { status: 404 } : { status: 403 }
  });
  await assert.rejects(
    reconcileCalendar(Object.assign({ sites: [], mode: 'detail', concurrency: 1 }, io)),
    (error) => {
      assert.equal(error.code, 'CALENDAR_SYNC_DELETE_FAILED');
      assert.equal(error.result.applied.delete, 1);
      assert.equal(error.result.failures[0].eventId, 'legacy-fail');
      assert.equal(error.result.failures[0].status, 403);
      return true;
    }
  );
});

test('dry run reports exact plans without any mutation adapters', async () => {
  const desired = buildDesiredEvents([site()], 'simple')[0];
  const changed = Object.assign({}, desired, { summary: '이전 제목' });
  const existing = [changed, managedLegacy('legacy', '성수 곳간'), { id: 'manual' }];
  let listed = 0;
  const result = await reconcileCalendar({
    sites: [site()],
    mode: 'simple',
    dryRun: true,
    listManagedEvents: async () => { listed += 1; return { status: 200, items: existing }; }
  });
  assert.equal(listed, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.planned, { create: 0, update: 1, delete: 1, unchanged: 0 });
  assert.deepEqual(result.applied, { create: 0, update: 0, delete: 0, unchanged: 0 });
  assert.equal(result.preservedManual, 1);
});

test('reconcileAll returns detail/simple results and summed counts', async () => {
  const detail = adapters([]);
  const simple = adapters([]);
  const result = await reconcileAll({
    sites: [site()],
    calendars: { detail, simple },
    concurrency: 2
  });
  assert.equal(result.ok, true);
  assert.equal(result.detail.desired, 3);
  assert.equal(result.simple.desired, 1);
  assert.equal(result.totals.planned.create, 4);
  assert.equal(result.totals.applied.create, 4);
});

test('missing or duplicate stable site identity fails closed', () => {
  assert.throws(
    () => buildDesiredEvents([{ snapshot: site().snapshot }], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_SITE_KEY_REQUIRED'
  );
  assert.throws(
    () => buildDesiredEvents([site(), site()], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_SITE_KEY_DUPLICATE'
  );
});

test('duplicate task identity fails closed before any calendar mutation can be planned', () => {
  const duplicateTasks = site().snapshot.tasks.slice(0, 2).map((task) => Object.assign({}, task, {
    id: 7,
    split: false,
    sd2: '',
    ed2: ''
  }));
  assert.throws(
    () => buildDesiredEvents([site({ tasks: duplicateTasks })], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_TASK_ID_DUPLICATE'
  );
});

test('invalid source shape and impossible or reversed dates fail before listing or mutation', () => {
  assert.equal(isStrictDate('2026-02-28'), true);
  assert.equal(isStrictDate('2026-02-31'), false);
  assert.equal(isStrictDate('2026-2-03'), false);
  assert.throws(
    () => buildDesiredEvents([site({ tasks: null })], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_SITE_TASKS_REQUIRED'
  );
  assert.throws(
    () => buildDesiredEvents([site({ sd: '2026-09-10', ed: '2026-09-01' })], 'simple'),
    (error) => error.code === 'CALENDAR_SYNC_SITE_RANGE_INVALID'
  );
  assert.throws(
    () => buildDesiredEvents([site({
      tasks: [{ id: 1, name: '가설공사', on: true, sd: '2026-02-31', ed: '2026-03-02' }]
    })], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_TASK_RANGE_INVALID'
  );
  assert.throws(
    () => buildDesiredEvents([site({
      tasks: [{ id: 1, name: '가설공사', on: true, sd: '2026-09-10', ed: '2026-09-01' }]
    })], 'detail'),
    (error) => error.code === 'CALENDAR_SYNC_TASK_RANGE_INVALID'
  );
});

test('missing HTTP status from a calendar adapter is never treated as success', async () => {
  await assert.rejects(
    reconcileCalendar({
      sites: [site()],
      mode: 'simple',
      dryRun: true,
      listManagedEvents: async () => []
    }),
    (error) => error.code === 'CALENDAR_SYNC_LIST_FAILED'
  );
});
