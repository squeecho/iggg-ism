(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var MAX_PHASES = 5;

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
    if (mode !== 'auto' && mode !== 'manual') throw new Error('Invalid schedule mode');
    task[phaseFields(index).mode] = mode;
    return task;
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
    inferLegacyScheduleModes: inferLegacyScheduleModes,
    applyConstructionPeriod: applyConstructionPeriod,
    snapshotForIdentity: snapshotForIdentity,
    updateLocalDraft: updateLocalDraft,
    dayDiff: dayDiff,
    addDays: addDays
  };
});
