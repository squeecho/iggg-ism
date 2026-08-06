(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var MAX_PHASES = 5;
  var MIN_CUSTOM_TASK_ID = 1000000000;
  var DEFAULT_TASK_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 12, 14];
  var DEFAULT_TASK_NAMES = {
    1: '가설공사', 2: '철거공사', 3: '소방공사', 4: '목공사',
    5: '전기공사', 6: '도장공사', 7: '금속공사', 8: '설비공사',
    9: '타일공사', 10: '공조공사', 11: '필름공사', 12: '가스공사',
    13: '기타공사', 14: '준공청소'
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeSiteName(value) {
    var text = String(value == null ? '' : value);
    if (typeof text.normalize === 'function') text = text.normalize('NFKC');
    return text.trim().replace(/\s+/g, ' ');
  }

  function canonicalSiteName(value) {
    return normalizeSiteName(value).toLocaleLowerCase('ko-KR');
  }

  function findSiteNameConflict(localSites, cloudSites, candidate, options) {
    var canonical = canonicalSiteName(candidate);
    if (!canonical) return null;
    var opts = options || {};
    var excluded = (opts.excludeNames || []).map(canonicalSiteName);

    function scan(items, source) {
      var list = Array.isArray(items) ? items : [];
      for (var i = 0; i < list.length; i++) {
        var site = list[i] || {};
        var siteCanonical = canonicalSiteName(site.pn);
        if (!siteCanonical || excluded.indexOf(siteCanonical) >= 0) continue;
        if (siteCanonical === canonical) {
          return { source: source, site: site, name: site.pn, index: i };
        }
      }
      return null;
    }

    return scan(localSites, 'local') || scan(cloudSites, 'cloud');
  }

  function phaseFields(index) {
    var suffix = index === 1 ? '' : String(index);
    return {
      index: index,
      enabled: index === 1 ? null : (index === 2 ? 'split' : 'split' + suffix),
      start: 'sd' + suffix,
      end: 'ed' + suffix,
      name: 'name' + suffix,
      description: 'desc' + suffix,
      mode: index === 1 ? 'scheduleMode' : 'scheduleMode' + suffix
    };
  }

  function isPhaseEnabled(task, index) {
    if (!task || index < 1 || index > MAX_PHASES) return false;
    if (index === 1) return true;
    return task[phaseFields(index).enabled] === true;
  }

  function getTaskPhase(task, index) {
    if (!task || index < 1 || index > MAX_PHASES) return null;
    var fields = phaseFields(index);
    return {
      index: index,
      enabled: isPhaseEnabled(task, index),
      sd: task[fields.start] || '',
      ed: task[fields.end] || '',
      name: task[fields.name] || task.name || '',
      desc: task[fields.description] || '',
      mode: task[fields.mode] === 'auto' || task[fields.mode] === 'manual'
        ? task[fields.mode]
        : ''
    };
  }

  function getTaskPhases(task, options) {
    var opts = options || {};
    var phases = [];
    for (var index = 1; index <= MAX_PHASES; index++) {
      var phase = getTaskPhase(task, index);
      if (!phase) continue;
      if (opts.activeOnly && !phase.enabled) continue;
      if (opts.validOnly && (!phase.sd || !phase.ed)) continue;
      phases.push(phase);
    }
    return phases;
  }

  function setTaskPhaseRange(task, index, sd, ed) {
    var fields = phaseFields(index);
    task[fields.start] = sd || '';
    task[fields.end] = ed || '';
    return task;
  }

  function setTaskPhaseMode(task, index, mode) {
    if (!task || index < 1 || index > MAX_PHASES) throw new Error('Invalid task phase');
    if (mode !== 'auto' && mode !== 'manual') throw new Error('Invalid schedule mode');
    task[phaseFields(index).mode] = mode;
    return task;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function normalizeTask(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error('Invalid task');
    }

    if (task.name == null) task.name = '';
    if (task.desc == null) task.desc = '';
    if (task.sd == null) task.sd = '';
    if (task.ed == null) task.ed = '';
    if (task.scheduleMode == null) task.scheduleMode = '';
    if (task.contractors == null) task.contractors = [];
    if (task.canSplit === undefined) task.canSplit = true;
    if (task.custom === undefined) task.custom = false;

    for (var index = 2; index <= MAX_PHASES; index++) {
      var fields = phaseFields(index);
      if (task[fields.enabled] === undefined) task[fields.enabled] = false;
      if (task[fields.start] == null) task[fields.start] = '';
      if (task[fields.end] == null) task[fields.end] = '';
      if (task[fields.description] == null) task[fields.description] = '';
      if (task[fields.mode] == null) task[fields.mode] = '';
    }

    /* A later legacy phase implies all preceding phases. Values are never cleared. */
    for (index = MAX_PHASES; index >= 2; index--) {
      fields = phaseFields(index);
      if (task[fields.enabled] !== true) continue;
      for (var previous = 2; previous < index; previous++) {
        task[phaseFields(previous).enabled] = true;
      }
    }

    for (index = 2; index <= MAX_PHASES; index++) {
      fields = phaseFields(index);
      if (task[fields.name] == null) {
        task[fields.name] = isPhaseEnabled(task, index) ? String(task.name || '') : '';
      }
    }
    return task;
  }

  function hasAutomaticNoteRule(note) {
    if (!note || typeof note !== 'object') return false;
    return note.type === 'auto' || note.type === 'auto_mk' ||
      note.type === 'auto_sb' || Number(note.id) === 1;
  }

  function normalizeNote(note) {
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      throw new Error('Invalid note');
    }
    if (note.dt == null) note.dt = '';
    if (note.chk === undefined) note.chk = false;
    if (note.dateMode !== 'auto' && note.dateMode !== 'manual') {
      if (note.type === 'auto') {
        note.dateMode = 'auto';
      } else if (note.type === 'auto_mk' || note.type === 'auto_sb' || Number(note.id) === 1) {
        note.dateMode = note.dt ? 'manual' : 'auto';
      } else {
        note.dateMode = 'manual';
      }
    }
    return note;
  }

  function normalizeScheduleState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Invalid schedule state');
    }
    if (!Array.isArray(state.tasks)) state.tasks = [];
    if (!Array.isArray(state.notes)) state.notes = [];
    state.tasks.forEach(normalizeTask);
    state.notes.forEach(normalizeNote);
    return state;
  }

  function getTaskPhaseCount(task) {
    if (!task || typeof task !== 'object') return 0;
    var count = 1;
    for (var index = 2; index <= MAX_PHASES; index++) {
      if (isPhaseEnabled(task, index)) count = index;
    }
    return count;
  }

  function getTaskRanges(task) {
    return getTaskPhases(task, { activeOnly: true, validOnly: true });
  }

  function setTaskPhaseEnabled(task, index, enabled) {
    if (!task || index < 1 || index > MAX_PHASES) throw new Error('Invalid task phase');
    if (index === 1) return task;
    if (enabled) {
      for (var current = 2; current <= index; current++) {
        task[phaseFields(current).enabled] = true;
      }
    } else {
      for (current = index; current <= MAX_PHASES; current++) {
        task[phaseFields(current).enabled] = false;
      }
    }
    return task;
  }

  function updateTaskPhase(task, index, patch) {
    if (!task || index < 1 || index > MAX_PHASES) throw new Error('Invalid task phase');
    var next = patch || {};
    var fields = phaseFields(index);
    if (index > 1 && hasOwn(next, 'enabled')) {
      setTaskPhaseEnabled(task, index, !!next.enabled);
    }
    if (hasOwn(next, 'sd')) task[fields.start] = next.sd || '';
    if (hasOwn(next, 'ed')) task[fields.end] = next.ed || '';
    if (hasOwn(next, 'name')) task[fields.name] = String(next.name == null ? '' : next.name);
    if (hasOwn(next, 'desc')) task[fields.description] = String(next.desc == null ? '' : next.desc);
    if (hasOwn(next, 'description')) {
      task[fields.description] = String(next.description == null ? '' : next.description);
    }
    if (hasOwn(next, 'mode')) {
      if (next.mode === '') task[fields.mode] = '';
      else setTaskPhaseMode(task, index, next.mode);
    }
    return task;
  }

  function addTaskPhase(task, patch) {
    normalizeTask(task);
    var currentCount = getTaskPhaseCount(task);
    if (currentCount >= MAX_PHASES) return null;
    var index = currentCount + 1;
    var fields = phaseFields(index);
    setTaskPhaseEnabled(task, index, true);
    if (!task[fields.name]) task[fields.name] = String(task.name || '');
    if (!task[fields.description]) task[fields.description] = String(task.desc || '');
    if (task[fields.mode] !== 'auto' && task[fields.mode] !== 'manual') {
      task[fields.mode] = 'manual';
    }
    updateTaskPhase(task, index, patch || {});
    return getTaskPhase(task, index);
  }

  function removeLastTaskPhase(task) {
    normalizeTask(task);
    var index = getTaskPhaseCount(task);
    if (index <= 1) return null;
    var removed = getTaskPhase(task, index);
    var fields = phaseFields(index);
    task[fields.enabled] = false;
    task[fields.start] = '';
    task[fields.end] = '';
    task[fields.name] = '';
    task[fields.description] = '';
    task[fields.mode] = '';
    return removed;
  }

  function toSafeTaskId(value) {
    if (value === '' || value == null) return null;
    var numeric = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
  }

  function visitScheduleStates(sources, visitor) {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    function visit(value) {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object') return;
      if (seen) {
        if (seen.has(value)) return;
        seen.add(value);
      }
      if (Array.isArray(value.tasks)) {
        visitor(value);
        return;
      }
      if (typeof value.snap === 'string' && value.snap) {
        try { visit(JSON.parse(value.snap)); } catch (error) {}
      } else if (value.snap && typeof value.snap === 'object') {
        visit(value.snap);
      }
      if (value.state) visit(value.state);
      if (value.site) visit(value.site);
      if (value.sites) visit(value.sites);
      if (value.records) visit(value.records);
    }
    visit(sources);
  }

  function collectTaskIds(sources) {
    var ids = [];
    var seenIds = {};
    visitScheduleStates(sources, function(state) {
      state.tasks.forEach(function(task) {
        var id = toSafeTaskId(task && task.id);
        if (id == null || seenIds[id]) return;
        seenIds[id] = true;
        ids.push(id);
      });
    });
    return ids;
  }

  function secureRandomTaskId() {
    var cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') {
      throw new Error('Secure random source unavailable');
    }
    var values = new Uint32Array(2);
    cryptoObject.getRandomValues(values);
    return (values[0] & 0x1fffff) * 0x100000000 + values[1];
  }

  function createCustomTaskId(usedIds, randomSource) {
    var used = {};
    function addUsed(value) {
      if (value instanceof Set) {
        value.forEach(addUsed);
      } else if (Array.isArray(value)) {
        value.forEach(addUsed);
      } else {
        var id = toSafeTaskId(value);
        if (id != null) used[id] = true;
      }
    }
    addUsed(usedIds || []);
    var nextRandom = typeof randomSource === 'function' ? randomSource : secureRandomTaskId;
    for (var attempt = 0; attempt < 128; attempt++) {
      var candidate = toSafeTaskId(nextRandom());
      if (candidate != null && candidate >= MIN_CUSTOM_TASK_ID && !used[candidate]) return candidate;
    }
    for (candidate = MIN_CUSTOM_TASK_ID; candidate <= Number.MAX_SAFE_INTEGER; candidate++) {
      if (!used[candidate]) return candidate;
    }
    throw new Error('No custom task ID available');
  }

  function createCustomTask(state, attributes, options) {
    normalizeScheduleState(state);
    var attrs = attributes && typeof attributes === 'object' ? Object.assign({}, attributes) : {};
    var opts = options || {};
    var used = collectTaskIds([state, opts.sources || []]);
    var requestedId = hasOwn(attrs, 'id') ? toSafeTaskId(attrs.id) : null;
    var id;
    if (hasOwn(attrs, 'id')) {
      if (requestedId == null || requestedId < MIN_CUSTOM_TASK_ID || used.indexOf(requestedId) >= 0) {
        throw new Error('Invalid or duplicate custom task ID');
      }
      id = requestedId;
    } else {
      id = createCustomTaskId(used, opts.randomSource);
    }
    var task = Object.assign({
      id: id,
      custom: true,
      name: '새 공종',
      desc: '',
      sd: state.sd || '',
      ed: state.sd || '',
      on: true,
      canSplit: true,
      contractors: [],
      scheduleMode: 'auto'
    }, attrs);
    task.id = id;
    task.custom = true;
    if (Array.isArray(task.contractors)) task.contractors = task.contractors.slice();
    normalizeTask(task);
    state.tasks.push(task);
    return task;
  }

  function deleteCustomTask(state, id) {
    if (!state || !Array.isArray(state.tasks)) return false;
    var numericId = toSafeTaskId(id);
    if (numericId == null) return false;
    var index = state.tasks.findIndex(function(task) {
      return toSafeTaskId(task && task.id) === numericId;
    });
    if (index < 0 || state.tasks[index].custom !== true) return false;
    state.tasks.splice(index, 1);
    return true;
  }

  function orderedTaskIds(states, baseOrder) {
    var observed = [];
    var observedSet = {};
    visitScheduleStates(states, function(state) {
      state.tasks.forEach(function(task) {
        var id = toSafeTaskId(task && task.id);
        if (id == null || observedSet[id]) return;
        observedSet[id] = true;
        observed.push(id);
      });
    });
    var result = [];
    (Array.isArray(baseOrder) ? baseOrder : DEFAULT_TASK_ORDER).forEach(function(value) {
      var id = toSafeTaskId(value);
      if (id != null && observedSet[id] && result.indexOf(id) < 0) result.push(id);
    });
    observed.forEach(function(id) {
      if (result.indexOf(id) < 0) result.push(id);
    });
    return result;
  }

  function resolveTaskName(id, states, fallback) {
    var numericId = toSafeTaskId(id);
    var resolved = '';
    visitScheduleStates(states, function(state) {
      if (resolved) return;
      var task = state.tasks.find(function(candidate) {
        return toSafeTaskId(candidate && candidate.id) === numericId;
      });
      if (task && task.name) resolved = String(task.name);
    });
    if (resolved) return resolved;
    if (numericId != null && DEFAULT_TASK_NAMES[numericId]) return DEFAULT_TASK_NAMES[numericId];
    return fallback == null ? (numericId == null ? '' : '공종 ' + numericId) : String(fallback);
  }

  function sameRange(left, right) {
    return !!left && !!right && left.sd === right.sd && left.ed === right.ed;
  }

  function inferLegacyScheduleModes(state, automaticBaseline) {
    var baselineById = {};
    ((automaticBaseline && automaticBaseline.tasks) || []).forEach(function(task) {
      baselineById[String(task.id)] = task;
    });
    (state.tasks || []).forEach(function(task) {
      var baselineTask = baselineById[String(task.id)];
      for (var index = 1; index <= MAX_PHASES; index++) {
        if (!isPhaseEnabled(task, index)) continue;
        var fields = phaseFields(index);
        if (task[fields.mode] === 'auto' || task[fields.mode] === 'manual') continue;
        var current = getTaskPhase(task, index);
        var automatic = baselineTask ? getTaskPhase(baselineTask, index) : null;
        var calculated = baselineTask && baselineTask._autoCalculatedPhases;
        var matchedAutomatic = calculated && calculated[index] && sameRange(current, automatic);
        task[fields.mode] = matchedAutomatic ? 'auto' : 'manual';
      }
    });
    return state;
  }

  function parseDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    var date = new Date(value + 'T00:00:00');
    return isNaN(date.getTime()) ? null : date;
  }

  function formatDate(date) {
    if (!date || isNaN(date.getTime())) return '';
    function pad(value) { return String(value).padStart(2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function dayDiff(from, to) {
    var start = parseDate(from);
    var end = parseDate(to);
    if (!start || !end) return 0;
    return Math.round((end - start) / 86400000);
  }

  function addDays(value, days) {
    var date = parseDate(value);
    if (!date) return '';
    date.setDate(date.getDate() + days);
    return formatDate(date);
  }

  function findTask(state, id) {
    if (!state || !Array.isArray(state.tasks)) return null;
    var numericId = toSafeTaskId(id);
    if (numericId == null) return null;
    return state.tasks.find(function(task) {
      return toSafeTaskId(task && task.id) === numericId;
    }) || null;
  }

  function taskBoundary(state, id, boundary) {
    var task = findTask(state, id);
    if (!task || task.on !== true) return '';
    var dates = getTaskRanges(task).map(function(phase) {
      return boundary === 'start' ? phase.sd : phase.ed;
    }).filter(function(value) {
      return !!parseDate(value);
    });
    if (!dates.length) return '';
    dates.sort();
    return boundary === 'start' ? dates[0] : dates[dates.length - 1];
  }

  function getAutoNoteDate(note, state) {
    if (!hasAutomaticNoteRule(note)) return '';
    var boundary = '';
    if (note.type === 'auto') {
      boundary = taskBoundary(state, 14, 'end');
      return boundary ? addDays(boundary, 1) : '';
    }
    if (note.type === 'auto_mk') {
      boundary = taskBoundary(state, 4, 'end');
      return boundary ? addDays(boundary, 1) : '';
    }
    if (note.type === 'auto_sb') {
      boundary = taskBoundary(state, 8, 'end');
      return boundary ? addDays(boundary, 2) : '';
    }
    if (Number(note.id) === 1) {
      boundary = taskBoundary(state, 9, 'end');
      if (boundary) return addDays(boundary, 2);
      return taskBoundary(state, 13, 'start');
    }
    return '';
  }

  function getNoteDate(note, state) {
    normalizeNote(note);
    return note.dateMode === 'auto' ? getAutoNoteDate(note, state) : String(note.dt || '');
  }

  function setNoteMode(note, state, mode) {
    normalizeNote(note);
    if (mode !== 'auto' && mode !== 'manual') throw new Error('Invalid note date mode');
    if (mode === 'auto') {
      if (!hasAutomaticNoteRule(note)) return false;
      note.dateMode = 'auto';
      note.dt = '';
      return true;
    }
    if (note.dateMode === 'auto') note.dt = getAutoNoteDate(note, state);
    note.dateMode = 'manual';
    return true;
  }

  function setNoteManualDate(note, date) {
    normalizeNote(note);
    var value = String(date || '');
    if (value && !parseDate(value)) throw new Error('Invalid note date');
    note.dateMode = 'manual';
    note.dt = value;
    return note;
  }

  function isNoteOutsidePeriod(note, state) {
    if (!note || !state) return false;
    normalizeNote(note);
    if (note.dateMode !== 'manual') return false;
    var date = parseDate(note.dt);
    var start = parseDate(state.sd);
    var end = parseDate(state.ed);
    if (!date || !start || !end) return false;
    return date < start || date > end;
  }

  function rebaseRange(range, oldStart, oldEnd, newStart, newEnd) {
    if (!range || !range.sd || !range.ed) return { sd: '', ed: '' };
    var oldLength = Math.max(1, dayDiff(oldStart, oldEnd));
    var newLength = Math.max(0, dayDiff(newStart, newEnd));
    var offset = dayDiff(oldStart, range.sd);
    var ratio = offset / oldLength;
    var newOffset = Math.max(0, Math.min(newLength, Math.round(ratio * newLength)));
    var duration = Math.max(0, dayDiff(range.sd, range.ed));
    if (duration > newLength) return { sd: newStart, ed: newEnd };
    var sd = addDays(newStart, newOffset);
    var ed = addDays(sd, duration);
    if (ed > newEnd) {
      ed = newEnd;
      sd = addDays(ed, -duration);
    }
    return { sd: sd, ed: ed };
  }

  function applyConstructionPeriod(state, newStart, newEnd, computeAutomatic) {
    if (!state || !Array.isArray(state.tasks)) throw new Error('Invalid schedule state');
    if (!parseDate(newStart) || !parseDate(newEnd)) throw new Error('Invalid construction period');
    if (newEnd < newStart) {
      var swap = newStart;
      newStart = newEnd;
      newEnd = swap;
    }

    var before = clone(state);
    var oldBaseline = clone(before);
    if (typeof computeAutomatic === 'function') computeAutomatic(oldBaseline, { baseline: true });
    inferLegacyScheduleModes(state, oldBaseline);

    state.sd = newStart;
    state.ed = newEnd;
    var automatic = clone(state);
    if (typeof computeAutomatic === 'function') computeAutomatic(automatic, { respectManual: true });

    var oldById = {};
    var autoById = {};
    (before.tasks || []).forEach(function(task) { oldById[String(task.id)] = task; });
    (automatic.tasks || []).forEach(function(task) { autoById[String(task.id)] = task; });

    (state.tasks || []).forEach(function(task) {
      if (!task.on) return;
      var oldTask = oldById[String(task.id)];
      var autoTask = autoById[String(task.id)];
      for (var index = 1; index <= MAX_PHASES; index++) {
        if (!isPhaseEnabled(task, index)) continue;
        var fields = phaseFields(index);
        if (task[fields.mode] !== 'auto') continue;
        var oldRange = oldTask ? getTaskPhase(oldTask, index) : null;
        var autoRange = autoTask ? getTaskPhase(autoTask, index) : null;
        var calculated = autoTask && autoTask._autoCalculatedPhases;
        var nextRange = calculated && calculated[index]
          ? autoRange
          : rebaseRange(oldRange, before.sd, before.ed, newStart, newEnd);
        setTaskPhaseRange(task, index, nextRange.sd, nextRange.ed);
      }
    });
    return state;
  }

  function snapshotForIdentity(state, identity) {
    var snapshot = clone(state);
    snapshot.pn = String(identity == null ? '' : identity);
    return snapshot;
  }

  function updateLocalDraft(records, state, identity, savedAt, author) {
    var list = Array.isArray(records) ? records.slice() : [];
    var exactIdentity = String(identity == null ? '' : identity);
    var index = list.findIndex(function(record) {
      return record && record.pn === exactIdentity;
    });
    if (index < 0) return { records: list, updated: false, index: -1 };
    var snapshot = snapshotForIdentity(state, exactIdentity);
    var encoded = JSON.stringify(snapshot);
    if (list[index].snap === encoded) return { records: list, updated: false, index: index };
    list[index] = Object.assign({}, list[index], {
      pn: exactIdentity,
      sd: snapshot.sd,
      ed: snapshot.ed,
      savedAt: savedAt,
      snap: encoded,
      author: author || list[index].author
    });
    return { records: list, updated: true, index: index, snapshot: snapshot };
  }

  return {
    MAX_PHASES: MAX_PHASES,
    MIN_CUSTOM_TASK_ID: MIN_CUSTOM_TASK_ID,
    DEFAULT_TASK_ORDER: DEFAULT_TASK_ORDER.slice(),
    clone: clone,
    normalizeSiteName: normalizeSiteName,
    canonicalSiteName: canonicalSiteName,
    findSiteNameConflict: findSiteNameConflict,
    phaseFields: phaseFields,
    isPhaseEnabled: isPhaseEnabled,
    getTaskPhase: getTaskPhase,
    getTaskPhases: getTaskPhases,
    setTaskPhaseRange: setTaskPhaseRange,
    setTaskPhaseMode: setTaskPhaseMode,
    normalizeTask: normalizeTask,
    normalizeNote: normalizeNote,
    normalizeScheduleState: normalizeScheduleState,
    getTaskPhaseCount: getTaskPhaseCount,
    getTaskRanges: getTaskRanges,
    setTaskPhaseEnabled: setTaskPhaseEnabled,
    updateTaskPhase: updateTaskPhase,
    addTaskPhase: addTaskPhase,
    removeLastTaskPhase: removeLastTaskPhase,
    collectTaskIds: collectTaskIds,
    createCustomTaskId: createCustomTaskId,
    createCustomTask: createCustomTask,
    deleteCustomTask: deleteCustomTask,
    orderedTaskIds: orderedTaskIds,
    resolveTaskName: resolveTaskName,
    hasAutomaticNoteRule: hasAutomaticNoteRule,
    getAutoNoteDate: getAutoNoteDate,
    getNoteDate: getNoteDate,
    setNoteMode: setNoteMode,
    setNoteManualDate: setNoteManualDate,
    isNoteOutsidePeriod: isNoteOutsidePeriod,
    inferLegacyScheduleModes: inferLegacyScheduleModes,
    applyConstructionPeriod: applyConstructionPeriod,
    snapshotForIdentity: snapshotForIdentity,
    updateLocalDraft: updateLocalDraft,
    dayDiff: dayDiff,
    addDays: addDays
  };
});
