'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../schedule-core.js');

test('site names use NFKC, whitespace and case normalization', () => {
  assert.equal(core.normalizeSiteName('  A\u3000  B  '), 'A B');
  assert.equal(core.canonicalSiteName('ＳＥＯＵＬ  Site'), 'seoul site');
  const conflict = core.findSiteNameConflict(
    [{ pn: '서울 현장' }],
    [{ pn: 'Busan Site' }],
    '  SEOUL   SITE '
  );
  assert.equal(conflict, null);
  assert.equal(
    core.findSiteNameConflict([], [{ pn: 'ＳＥＯＵＬ  Site' }], 'seoul site').source,
    'cloud'
  );
  assert.equal(
    core.findSiteNameConflict([{ pn: '  부산\t현장 ' }], [], '부산 현장').source,
    'local'
  );
  assert.equal(
    core.findSiteNameConflict([{ pn: 'Archived SITE', archived: true }], [], 'archived site').site.archived,
    true
  );
});

test('local draft keeps the original identity during a pending rename', () => {
  const records = [
    { pn: 'Site A', snap: JSON.stringify({ pn: 'Site A', marker: 'A-original' }) },
    { pn: 'Site B', snap: JSON.stringify({ pn: 'Site B', marker: 'B-original' }) }
  ];
  const state = { pn: 'Site B', sd: '2026-08-01', ed: '2026-08-10', marker: 'A-edited' };
  const result = core.updateLocalDraft(records, state, 'Site A', 'now', 'device');

  assert.equal(JSON.parse(result.records[0].snap).pn, 'Site A');
  assert.equal(JSON.parse(result.records[0].snap).marker, 'A-edited');
  assert.equal(JSON.parse(result.records[1].snap).marker, 'B-original');
});

test('local draft preserves an exact legacy identity and never canonical-matches another record', () => {
  const legacy = '  Site\u3000 A  ';
  const records = [
    { pn: 'Site A', snap: JSON.stringify({ pn: 'Site A', marker: 'first' }) },
    { pn: legacy, snap: JSON.stringify({ pn: legacy, marker: 'legacy' }) }
  ];
  const result = core.updateLocalDraft(records, { pn: 'site a', marker: 'edited' }, legacy, 'now');
  assert.equal(result.records[0].pn, 'Site A');
  assert.equal(JSON.parse(result.records[0].snap).marker, 'first');
  assert.equal(result.records[1].pn, legacy);
  assert.equal(JSON.parse(result.records[1].snap).pn, legacy);
  assert.equal(JSON.parse(result.records[1].snap).marker, 'edited');
});

test('phase 2 uses the legacy split key', () => {
  const task = { name: 'Electrical', split: true, sd2: '2026-08-10', ed2: '2026-08-12' };
  assert.equal(core.isPhaseEnabled(task, 2), true);
  assert.deepEqual(core.getTaskPhases(task, { activeOnly: true }).map((phase) => phase.index), [1, 2]);
});

test('construction period recalculates auto ranges and preserves manual ranges', () => {
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-10',
    tasks: [
      { id: 1, on: true, sd: '2026-08-01', ed: '2026-08-03', scheduleMode: 'auto' },
      { id: 2, on: true, sd: '2026-07-20', ed: '2026-07-22', scheduleMode: 'manual' }
    ]
  };
  function computeAutomatic(target) {
    const task = target.tasks[0];
    task.sd = target.sd;
    task.ed = core.addDays(target.sd, 2);
    Object.defineProperty(task, '_autoCalculatedPhases', { value: { 1: true } });
  }

  core.applyConstructionPeriod(state, '2026-09-01', '2026-09-20', computeAutomatic);
  assert.deepEqual(
    state.tasks.map(({ sd, ed, scheduleMode }) => ({ sd, ed, scheduleMode })),
    [
      { sd: '2026-09-01', ed: '2026-09-03', scheduleMode: 'auto' },
      { sd: '2026-07-20', ed: '2026-07-22', scheduleMode: 'manual' }
    ]
  );
});

test('legacy ranges are auto only when they match the old automatic baseline', () => {
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-10',
    tasks: [
      { id: 1, on: true, sd: '2026-08-01', ed: '2026-08-03' },
      { id: 2, on: true, sd: '2026-07-20', ed: '2026-07-22' }
    ]
  };
  function computeAutomatic(target) {
    target.tasks.forEach((task) => {
      task.sd = target.sd;
      task.ed = core.addDays(target.sd, 2);
      Object.defineProperty(task, '_autoCalculatedPhases', { value: { 1: true } });
    });
  }

  core.applyConstructionPeriod(state, '2026-09-01', '2026-09-20', computeAutomatic);
  assert.equal(state.tasks[0].scheduleMode, 'auto');
  assert.equal(state.tasks[0].sd, '2026-09-01');
  assert.equal(state.tasks[1].scheduleMode, 'manual');
  assert.equal(state.tasks[1].sd, '2026-07-20');
});

test('generic automatic phase rebasing remains inside a shortened construction period', () => {
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-31',
    tasks: [{
      id: 1,
      on: true,
      sd: '2026-08-01',
      ed: '2026-08-02',
      scheduleMode: 'manual',
      split3: true,
      sd3: '2026-08-25',
      ed3: '2026-08-30',
      scheduleMode3: 'auto'
    }]
  };
  core.applyConstructionPeriod(state, '2026-09-01', '2026-09-03');
  assert.equal(state.tasks[0].sd3, '2026-09-01');
  assert.equal(state.tasks[0].ed3, '2026-09-03');
});
