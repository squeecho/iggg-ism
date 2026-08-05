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

test('legacy phase data normalizes through phase 5 without losing stored values', () => {
  const task = {
    id: 5,
    name: '전기공사',
    desc: '배선',
    sd: '2026-08-01',
    ed: '2026-08-03',
    split: false,
    sd2: '2026-08-10',
    ed2: '2026-08-11',
    desc2: '입선',
    split3: true,
    sd3: '2026-08-20',
    ed3: '2026-08-21',
    desc3: '조명',
    legacyExtension: { untouched: true }
  };

  core.normalizeTask(task);

  assert.equal(task.split, true, 'phase 3 implies phase 2 for a legacy record');
  assert.equal(task.name2, '전기공사');
  assert.equal(task.name3, '전기공사');
  assert.equal(task.split4, false);
  assert.equal(task.split5, false);
  assert.equal(task.sd2, '2026-08-10');
  assert.equal(task.ed3, '2026-08-21');
  assert.deepEqual(task.legacyExtension, { untouched: true });
  assert.deepEqual(core.getTaskRanges(task).map((phase) => phase.index), [1, 2, 3]);
});

test('phases can be added independently through phase 5 and removed only from the end', () => {
  const task = {
    id: 100,
    name: '기본 공종명',
    desc: '기본 설명',
    sd: '2026-08-01',
    ed: '2026-08-02',
    scheduleMode: 'auto'
  };
  core.normalizeTask(task);

  for (let index = 2; index <= 5; index++) {
    const phase = core.addTaskPhase(task, {
      name: `${index}차 이름`,
      desc: `${index}차 설명`,
      sd: `2026-08-${String(index * 2 - 1).padStart(2, '0')}`,
      ed: `2026-08-${String(index * 2).padStart(2, '0')}`,
      mode: index % 2 ? 'auto' : 'manual'
    });
    assert.equal(phase.index, index);
  }

  assert.equal(core.getTaskPhaseCount(task), 5);
  assert.equal(core.addTaskPhase(task), null);

  const reloaded = JSON.parse(JSON.stringify(task));
  core.normalizeTask(reloaded);
  assert.deepEqual(
    core.getTaskPhases(reloaded, { activeOnly: true }).map(({ index, name, desc, mode }) => ({ index, name, desc, mode })),
    [
      { index: 1, name: '기본 공종명', desc: '기본 설명', mode: 'auto' },
      { index: 2, name: '2차 이름', desc: '2차 설명', mode: 'manual' },
      { index: 3, name: '3차 이름', desc: '3차 설명', mode: 'auto' },
      { index: 4, name: '4차 이름', desc: '4차 설명', mode: 'manual' },
      { index: 5, name: '5차 이름', desc: '5차 설명', mode: 'auto' }
    ]
  );

  core.updateTaskPhase(reloaded, 4, { name: '수정된 4차', sd: '2026-08-22' });
  assert.equal(reloaded.name, '기본 공종명');
  assert.equal(reloaded.name4, '수정된 4차');
  assert.equal(reloaded.sd4, '2026-08-22');

  const removed = core.removeLastTaskPhase(reloaded);
  assert.equal(removed.index, 5);
  assert.equal(core.getTaskPhaseCount(reloaded), 4);
  assert.equal(reloaded.split5, false);
  assert.equal(reloaded.sd5, '');
  assert.equal(reloaded.name4, '수정된 4차');
});

test('disabling a phase preserves dormant values and disables only later phases', () => {
  const task = {
    name: '공종',
    sd: '2026-08-01',
    ed: '2026-08-02',
    split: true,
    sd2: '2026-08-03',
    ed2: '2026-08-04',
    split3: true,
    sd3: '2026-08-05',
    ed3: '2026-08-06'
  };
  core.normalizeTask(task);

  core.setTaskPhaseEnabled(task, 2, false);
  assert.equal(task.split, false);
  assert.equal(task.split3, false);
  assert.equal(task.sd2, '2026-08-03');
  assert.equal(task.sd3, '2026-08-05');

  core.setTaskPhaseEnabled(task, 3, true);
  assert.equal(task.split, true);
  assert.equal(task.split3, true);
  assert.deepEqual(core.getTaskRanges(task).map((phase) => phase.index), [1, 2, 3]);
});

test('custom task IDs account for local, cloud and serialized snapshots', () => {
  const sources = [
    { tasks: [{ id: 1000000001 }] },
    { snap: JSON.stringify({ tasks: [{ id: 1000000002 }] }) },
    { state: { tasks: [{ id: 1000000003 }] } }
  ];
  assert.deepEqual(core.collectTaskIds(sources), [1000000001, 1000000002, 1000000003]);

  const candidates = [1000000001, 42, 1000000009];
  const generated = core.createCustomTaskId(
    core.collectTaskIds(sources),
    () => candidates.shift()
  );
  assert.equal(generated, 1000000009);
});

test('custom tasks survive reload, use normal phase editing, and protect default tasks from deletion', () => {
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-31',
    tasks: [{ id: 1, name: '가설공사', sd: '2026-08-01', ed: '2026-08-03', on: true }],
    notes: []
  };
  const custom = core.createCustomTask(state, {
    id: 1000000010,
    name: '사인물 공사',
    desc: '현장 제작',
    contractors: ['업체 A'],
    sd: '2026-08-12',
    ed: '2026-08-14'
  });
  core.updateTaskPhase(custom, 1, { name: '사인 공사', desc: '수정 설명' });
  core.addTaskPhase(custom, {
    name: '설치',
    desc: '현장 설치',
    sd: '2026-08-20',
    ed: '2026-08-21',
    mode: 'manual'
  });

  const reloaded = JSON.parse(JSON.stringify(state));
  core.normalizeScheduleState(reloaded);
  const saved = reloaded.tasks.find((task) => task.id === 1000000010);
  assert.equal(saved.custom, true);
  assert.equal(saved.name, '사인 공사');
  assert.equal(saved.name2, '설치');
  assert.deepEqual(saved.contractors, ['업체 A']);
  assert.equal(saved.scheduleMode, 'auto');
  assert.equal(core.resolveTaskName(saved.id, reloaded), '사인 공사');
  assert.equal(core.resolveTaskName(5, reloaded), '전기공사');
  assert.equal(core.deleteCustomTask(reloaded, 1), false);
  assert.equal(core.deleteCustomTask(reloaded, saved.id), true);
  assert.equal(reloaded.tasks.some((task) => task.id === saved.id), false);
});

test('task ordering keeps the established default order and appends custom tasks by first appearance', () => {
  const firstCustom = 1000000020;
  const secondCustom = 1000000021;
  const states = [{
    tasks: [
      { id: firstCustom },
      { id: 14 },
      { id: 1 },
      { id: secondCustom },
      { id: 13 }
    ]
  }];
  assert.deepEqual(core.orderedTaskIds(states), [1, 13, 14, firstCustom, secondCustom]);
});

test('automatic note rules use the latest active phase and preserve legacy overrides', () => {
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-31',
    tasks: [
      { id: 4, on: true, name: '목공', sd: '2026-08-01', ed: '2026-08-10', split3: true, sd3: '2026-08-18', ed3: '2026-08-20' },
      { id: 8, on: true, name: '설비', sd: '2026-08-02', ed: '2026-08-12', split: true, sd2: '2026-08-16', ed2: '2026-08-18' },
      { id: 9, on: true, name: '타일', sd: '2026-08-10', ed: '2026-08-15', split5: true, sd5: '2026-08-24', ed5: '2026-08-26' },
      { id: 13, on: true, name: '기타', sd: '2026-08-27', ed: '2026-08-30' },
      { id: 14, on: true, name: '청소', sd: '2026-08-31', ed: '2026-08-31', split: true, sd2: '2026-09-01', ed2: '2026-09-01' }
    ],
    notes: []
  };
  core.normalizeScheduleState(state);

  assert.equal(core.getNoteDate({ id: 4, type: 'auto_mk', dateMode: 'auto' }, state), '2026-08-21');
  assert.equal(core.getNoteDate({ id: 5, type: 'auto_sb', dateMode: 'auto' }, state), '2026-08-20');
  assert.equal(core.getNoteDate({ id: 1, type: 'manual', dateMode: 'auto' }, state), '2026-08-28');
  assert.equal(core.getNoteDate({ id: 2, type: 'auto', dateMode: 'auto' }, state), '2026-09-02');

  const legacyOverride = { id: 4, type: 'auto_mk', dt: '2026-08-07' };
  assert.equal(core.getNoteDate(legacyOverride, state), '2026-08-07');
  assert.equal(legacyOverride.dateMode, 'manual');

  const legacyAlwaysAuto = { id: 2, type: 'auto', dt: '2026-08-07' };
  assert.equal(core.getNoteDate(legacyAlwaysAuto, state), '2026-09-02');
  assert.equal(legacyAlwaysAuto.dateMode, 'auto');
});

test('manual note dates stay fixed outside the construction period and auto mode recalculates', () => {
  const note = { id: 4, type: 'auto_mk', dateMode: 'auto', dt: '' };
  const state = {
    sd: '2026-08-01',
    ed: '2026-08-31',
    tasks: [{
      id: 4,
      on: true,
      name: '목공',
      sd: '2026-08-04',
      ed: '2026-08-10',
      scheduleMode: 'auto'
    }],
    notes: [note]
  };
  core.normalizeScheduleState(state);

  assert.equal(core.setNoteMode(note, state, 'manual'), true);
  assert.equal(note.dt, '2026-08-11');
  core.setNoteManualDate(note, '2026-10-05');
  assert.equal(core.isNoteOutsidePeriod(note, state), true);

  function computeAutomatic(target) {
    const task = target.tasks[0];
    task.sd = core.addDays(target.sd, 3);
    task.ed = core.addDays(target.sd, 9);
    Object.defineProperty(task, '_autoCalculatedPhases', { value: { 1: true } });
  }
  core.applyConstructionPeriod(state, '2026-09-01', '2026-09-30', computeAutomatic);
  assert.equal(note.dt, '2026-10-05');
  assert.equal(core.getNoteDate(note, state), '2026-10-05');
  assert.equal(core.isNoteOutsidePeriod(note, state), true);

  assert.equal(core.setNoteMode(note, state, 'auto'), true);
  assert.equal(note.dt, '');
  assert.equal(core.getNoteDate(note, state), '2026-09-11');
  assert.equal(core.isNoteOutsidePeriod(note, state), false);

  const ordinary = { id: 99, type: 'manual', dateMode: 'manual', dt: '2026-09-10' };
  assert.equal(core.setNoteMode(ordinary, state, 'auto'), false);
  assert.equal(ordinary.dateMode, 'manual');
  assert.equal(ordinary.dt, '2026-09-10');
});
