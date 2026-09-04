'use strict';

const crypto = require('node:crypto');
const ScheduleCore = require('./schedule-core.js');

const SOURCE = 'iggg-ism';
const SCHEMA = 'iggg-ism/calendar-sync-v1';
const MODES = ['detail', 'simple'];
const COLOR_IDS = ['2', '4', '5', '6', '7', '8', '9', '10', '11', '1', '3'];
const TASK_SHORT = {
  '가설공사': '가설', '철거공사': '철거', '소방공사': '소방',
  '목공사': '목공', '전기공사': '전기', '도장공사': '도장',
  '금속공사': '금속', '설비공사': '설비', '타일공사': '타일',
  '공조공사': '공조', '필름공사': '필름', '가스공사': '가스',
  '기타공사': '기타', '준공청소': '청소'
};

class CalendarSyncError extends Error {
  constructor(code, phase, result, cause) {
    super(code);
    this.name = 'CalendarSyncError';
    this.code = code;
    this.phase = phase;
    this.result = result;
    if (cause) this.cause = cause;
  }
}

function requireMode(mode) {
  if (MODES.indexOf(mode) < 0) {
    throw new CalendarSyncError('CALENDAR_SYNC_MODE_INVALID', 'build', null);
  }
}

function readSiteRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new CalendarSyncError('CALENDAR_SYNC_SITE_INVALID', 'build', null);
  }
  let snapshot;
  if (typeof record.data === 'function') snapshot = record.data();
  else if (record.snapshot != null) snapshot = record.snapshot;
  else if (record.data && typeof record.data === 'object') snapshot = record.data;
  else snapshot = record;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); }
    catch (error) {
      throw new CalendarSyncError('CALENDAR_SYNC_SITE_INVALID', 'build', null, error);
    }
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new CalendarSyncError('CALENDAR_SYNC_SITE_INVALID', 'build', null);
  }
  const siteKey = record.siteKey || record.docKey || record.key ||
    (typeof record.data === 'function' ? record.id : '') || snapshot.siteKey || snapshot.docKey;
  if (!siteKey) {
    throw new CalendarSyncError('CALENDAR_SYNC_SITE_KEY_REQUIRED', 'build', null);
  }
  return { siteKey: String(siteKey), snapshot };
}

function isStrictDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day;
}

function addDays(date, amount) {
  if (!isStrictDate(date)) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function validateRange(start, end, code, result) {
  if (!isStrictDate(start) || !isStrictDate(end) || start > end) {
    throw new CalendarSyncError(code, 'build', result || null);
  }
}

function validateActiveSnapshot(siteKey, snapshot) {
  const pn = String(snapshot && snapshot.pn || '').trim();
  if (!pn) throw new CalendarSyncError('CALENDAR_SYNC_SITE_NAME_REQUIRED', 'build', { siteKey });
  if (!Array.isArray(snapshot.tasks)) {
    throw new CalendarSyncError('CALENDAR_SYNC_SITE_TASKS_REQUIRED', 'build', { siteKey });
  }
  if (snapshot.sd || snapshot.ed) {
    validateRange(snapshot.sd, snapshot.ed, 'CALENDAR_SYNC_SITE_RANGE_INVALID', { siteKey });
  }
  const taskIds = new Set();
  snapshot.tasks.forEach((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new CalendarSyncError('CALENDAR_SYNC_TASK_INVALID', 'build', { siteKey });
    }
    const taskId = Number(task.id);
    if (task.id === '' || task.id == null || !Number.isSafeInteger(taskId) || taskId < 0) {
      throw new CalendarSyncError('CALENDAR_SYNC_TASK_ID_REQUIRED', 'build', { siteKey });
    }
    if (taskIds.has(taskId)) {
      throw new CalendarSyncError('CALENDAR_SYNC_TASK_ID_DUPLICATE', 'build', { siteKey, taskId });
    }
    taskIds.add(taskId);
    if (!task.on) return;
    if (!String(task.name || '').trim()) {
      throw new CalendarSyncError('CALENDAR_SYNC_TASK_NAME_REQUIRED', 'build', { siteKey, taskId });
    }
    ScheduleCore.getTaskPhases(task, { activeOnly: true }).forEach((phase) => {
      validateRange(phase.sd, phase.ed, 'CALENDAR_SYNC_TASK_RANGE_INVALID', {
        siteKey,
        taskId,
        phaseIndex: phase.index
      });
    });
  });
}

function stableEventId(siteKey, mode, identity) {
  const digest = crypto.createHash('sha256')
    .update([SCHEMA, siteKey, mode, identity].join('\u001f'), 'utf8')
    .digest('hex');
  return 'igism' + digest.slice(0, 48);
}

function colorIdFor(siteKey, pn) {
  const digest = crypto.createHash('sha256').update(siteKey + '\u001f' + pn, 'utf8').digest();
  return COLOR_IDS[digest.readUInt32BE(0) % COLOR_IDS.length];
}

function regionOf(pn) {
  const index = pn.indexOf(' ');
  return index > 0 ? pn.slice(0, index) : pn;
}

function eventTitle(pn, taskName, vendor) {
  const task = TASK_SHORT[taskName] || taskName || '';
  return regionOf(pn) + ' | ' + task + (vendor ? ' | ' + vendor : '');
}

function firstContractor(task) {
  if (!Array.isArray(task.contractors)) return '';
  for (let index = 0; index < task.contractors.length; index += 1) {
    const value = String(task.contractors[index] || '').trim();
    if (value) return value;
  }
  return '';
}

function privateProperties(siteKey, pn, identity, mode) {
  return {
    src: SOURCE,
    schema: SCHEMA,
    siteKey,
    pn,
    identity,
    mode
  };
}

function buildSimpleEvent(siteKey, snapshot) {
  const pn = String(snapshot.pn || '');
  let start = String(snapshot.sd || '');
  let end = String(snapshot.ed || '');
  ScheduleCore.orderedTasks(snapshot.tasks || []).forEach((task) => {
    if (!task.on) return;
    ScheduleCore.getTaskPhases(task, { activeOnly: true, validOnly: true }).forEach((phase) => {
      if (!start || phase.sd < start) start = phase.sd;
      if (!end || phase.ed > end) end = phase.ed;
    });
  });
  if (!start || !end || !addDays(end, 1)) return null;
  const identity = 'site';
  return {
    id: stableEventId(siteKey, 'simple', identity),
    status: 'confirmed',
    summary: pn,
    description: pn + ' 공사 전체 기간',
    start: { date: start },
    end: { date: addDays(end, 1) },
    colorId: colorIdFor(siteKey, pn),
    extendedProperties: { private: privateProperties(siteKey, pn, identity, 'simple') }
  };
}

function buildDetailEvents(siteKey, snapshot) {
  const pn = String(snapshot.pn || '');
  const colorId = colorIdFor(siteKey, pn);
  const result = [];
  ScheduleCore.orderedTasks(snapshot.tasks || []).forEach((task) => {
    if (!task.on) return;
    const phases = ScheduleCore.getTaskPhases(task, { activeOnly: true, validOnly: true });
    if (!phases.length) return;
    const vendor = firstContractor(task);
    phases.forEach((phase) => {
      const identity = 'task:' + String(task.id) + ':phase:' + phase.index;
      const suffix = phases.length > 1 ? ' (' + phase.index + '차)' : '';
      const description = pn + ' 공사 일정\n공종: ' + phase.name +
        (phase.desc ? '\n설명: ' + phase.desc : '') +
        (vendor ? '\n업체: ' + vendor : '') +
        (phases.length > 1 ? '\n(' + phase.index + '차 일정)' : '');
      result.push({
        id: stableEventId(siteKey, 'detail', identity),
        status: 'confirmed',
        summary: eventTitle(pn, phase.name, vendor) + suffix,
        description,
        start: { date: phase.sd },
        end: { date: addDays(phase.ed, 1) },
        colorId,
        extendedProperties: { private: privateProperties(siteKey, pn, identity, 'detail') }
      });
    });
  });
  return result;
}

function buildDesiredEvents(sites, mode) {
  requireMode(mode);
  const records = (Array.isArray(sites) ? sites : []).map(readSiteRecord);
  const seen = new Set();
  const events = [];
  records.sort((left, right) => left.siteKey.localeCompare(right.siteKey));
  records.forEach(({ siteKey, snapshot }) => {
    if (seen.has(siteKey)) {
      throw new CalendarSyncError('CALENDAR_SYNC_SITE_KEY_DUPLICATE', 'build', null);
    }
    seen.add(siteKey);
    if (snapshot.confirmed === false || snapshot.archived === true) return;
    validateActiveSnapshot(siteKey, snapshot);
    snapshot = ScheduleCore.normalizeScheduleState(ScheduleCore.clone(snapshot));
    if (mode === 'simple') {
      const event = buildSimpleEvent(siteKey, snapshot);
      if (event) events.push(event);
    } else {
      events.push(...buildDetailEvents(siteKey, snapshot));
    }
  });
  events.sort((left, right) => left.id.localeCompare(right.id));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].id === events[index].id) {
      throw new CalendarSyncError('CALENDAR_SYNC_EVENT_ID_DUPLICATE', 'build', {
        eventId: events[index].id
      });
    }
  }
  return events;
}

function privateOf(event) {
  return event && event.extendedProperties && event.extendedProperties.private || {};
}

function isManagedEvent(event) {
  return privateOf(event).src === SOURCE;
}

function ownershipOf(event, mode) {
  const value = privateOf(event);
  if (value.src !== SOURCE) return 'manual';
  if (value.schema === SCHEMA && value.mode === mode) return 'current';
  if (!value.schema && !value.mode && value.pn) return 'legacy';
  return 'unknown';
}

function comparableEvent(event) {
  const privateData = privateOf(event);
  return {
    status: String(event && event.status || ''),
    summary: String(event && event.summary || ''),
    description: String(event && event.description || ''),
    start: { date: String(event && event.start && event.start.date || '') },
    end: { date: String(event && event.end && event.end.date || '') },
    colorId: String(event && event.colorId || ''),
    extendedProperties: {
      private: {
        src: String(privateData.src || ''),
        schema: String(privateData.schema || ''),
        siteKey: String(privateData.siteKey || ''),
        pn: String(privateData.pn || ''),
        identity: String(privateData.identity || ''),
        mode: String(privateData.mode || '')
      }
    }
  };
}

function eventNeedsUpdate(existing, desired) {
  return JSON.stringify(comparableEvent(existing)) !== JSON.stringify(comparableEvent(desired));
}

function responseStatus(value) {
  if (!value) return 0;
  const status = Number(value.status || value.statusCode || (value.response && value.response.status));
  return Number.isFinite(status) ? status : 0;
}

function operationError(value, fallback) {
  if (value instanceof Error) return value;
  const error = new Error(fallback || 'Calendar operation failed');
  const status = responseStatus(value);
  if (status) error.status = status;
  error.response = value;
  return error;
}

function isSuccessResponse(value) {
  const status = responseStatus(value);
  return status >= 200 && status < 300;
}

function isTransient(error) {
  const status = responseStatus(error);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const code = String(error && error.code || '');
  if (['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNREFUSED'].includes(code)) return true;
  if (status !== 403) return false;
  const response = error && error.response || {};
  const body = response.body || {};
  const reasons = (((body.error || {}).errors) || []).map((entry) => String(entry && entry.reason || ''));
  return reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded');
}

async function callWithRetry(operation, options, result) {
  const attempts = Math.max(1, Number(options.maxAttempts) || 4);
  const requestedDelay = options.baseDelayMs == null ? 100 : Number(options.baseDelayMs);
  const baseDelayMs = Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : 100);
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const deadlineAt = Number(options.deadlineAt);
      const minimumRemainingMs = Math.max(0, Number(options.minimumRemainingMs) || 0);
      if (Number.isFinite(deadlineAt) && Date.now() + minimumRemainingMs >= deadlineAt) {
        const timeout = new Error('Calendar reconciliation deadline reached');
        timeout.code = 'CALENDAR_SYNC_DEADLINE';
        throw timeout;
      }
      const response = await operation();
      if (!isSuccessResponse(response)) throw operationError(response);
      return response;
    } catch (error) {
      lastError = operationError(error);
      if (!isTransient(lastError) || attempt >= attempts) throw lastError;
      result.retries += 1;
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw lastError;
}

async function mapBounded(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(16, Number(concurrency) || 4));
  let cursor = 0;
  const workers = [];
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  }
  for (let index = 0; index < Math.min(limit, items.length); index += 1) workers.push(run());
  await Promise.all(workers);
}

function initialResult(mode, dryRun, desired, existing, managed, unknown) {
  return {
    ok: false,
    dryRun: !!dryRun,
    partial: false,
    mode,
    desired: desired.length,
    existing: existing.length,
    managedExisting: managed.length,
    preservedManual: existing.length - managed.length,
    preservedUnknown: (unknown || []).length,
    planned: { create: 0, update: 0, delete: 0, unchanged: 0 },
    applied: { create: 0, update: 0, delete: 0, unchanged: 0 },
    deferred: { upsert: 0, delete: 0 },
    retries: 0,
    failures: []
  };
}

function failureRecord(operation, event, error) {
  return {
    operation,
    eventId: event && event.id || '',
    status: responseStatus(error) || null,
    message: String(error && error.message || error || 'Calendar operation failed')
  };
}

async function reconcileCalendar(options) {
  const opts = options || {};
  requireMode(opts.mode);
  const requiredAdapters = opts.dryRun
    ? ['listManagedEvents']
    : ['listManagedEvents', 'createEvent', 'updateEvent', 'deleteEvent'];
  requiredAdapters.forEach((name) => {
    if (typeof opts[name] !== 'function') {
      throw new CalendarSyncError('CALENDAR_SYNC_ADAPTER_REQUIRED', 'setup', { adapter: name });
    }
  });
  const desired = buildDesiredEvents(opts.sites, opts.mode);
  let listResponse;
  const listResult = { retries: 0 };
  try {
    listResponse = await callWithRetry(
      () => opts.listManagedEvents({ mode: opts.mode, source: SOURCE }), opts, listResult
    );
  } catch (error) {
    const result = initialResult(opts.mode, opts.dryRun, desired, [], [], []);
    result.retries = listResult.retries;
    result.failures.push(failureRecord('list', null, error));
    throw new CalendarSyncError('CALENDAR_SYNC_LIST_FAILED', 'list', result, error);
  }
  const existing = Array.isArray(listResponse) ? listResponse : (listResponse && listResponse.items) || [];
  const managed = existing.filter(isManagedEvent);
  const unknown = managed.filter((event) => ownershipOf(event, opts.mode) === 'unknown');
  const owned = managed.filter((event) => {
    const ownership = ownershipOf(event, opts.mode);
    return ownership === 'current' || ownership === 'legacy';
  });
  const result = initialResult(opts.mode, opts.dryRun, desired, existing, managed, unknown);
  result.retries = listResult.retries;
  if (unknown.length) {
    unknown.forEach((event) => result.failures.push({
      operation: 'ownership',
      eventId: event && event.id || '',
      status: null,
      message: 'Unknown managed calendar ownership'
    }));
    throw new CalendarSyncError('CALENDAR_SYNC_UNKNOWN_OWNERSHIP', 'ownership', result);
  }
  const existingById = new Map(owned.filter((event) => event && event.id).map((event) => [event.id, event]));
  const desiredIds = new Set(desired.map((event) => event.id));
  const upserts = [];
  desired.forEach((event) => {
    const current = existingById.get(event.id);
    if (!current) {
      result.planned.create += 1;
      upserts.push({ operation: 'create', event });
    } else if (eventNeedsUpdate(current, event)) {
      result.planned.update += 1;
      upserts.push({ operation: 'update', event });
    } else {
      result.planned.unchanged += 1;
      result.applied.unchanged += 1;
    }
  });
  const stale = owned.filter((event) => event && event.id && !desiredIds.has(event.id));
  result.planned.delete = stale.length;
  if (opts.dryRun) {
    result.ok = true;
    return result;
  }

  /* 초기 전환·대량 편집 때 Google Calendar의 단시간 write limit와 서버리스
     deadline을 넘기지 않도록 한 실행의 mutation 수를 제한한다. deferred
     upsert가 하나라도 있으면 stale 삭제는 0으로 유지하고 다음 주기에 이어간다. */
  const requestedBudget = Number(opts.mutationBudget);
  const mutationBudget = Number.isSafeInteger(requestedBudget) && requestedBudget > 0
    ? requestedBudget
    : Number.POSITIVE_INFINITY;
  const scheduledUpserts = upserts.slice(0, mutationBudget);
  result.deferred.upsert = upserts.length - scheduledUpserts.length;
  result.deferred.delete = result.deferred.upsert > 0 ? stale.length : 0;

  await mapBounded(scheduledUpserts, opts.concurrency, async (job) => {
    try {
      if (job.operation === 'create') {
        try {
          await callWithRetry(() => opts.createEvent(job.event), opts, result);
          result.applied.create += 1;
        } catch (error) {
          if (responseStatus(error) !== 409) throw error;
          await callWithRetry(() => opts.updateEvent(job.event.id, job.event), opts, result);
          result.applied.update += 1;
        }
      } else {
        await callWithRetry(() => opts.updateEvent(job.event.id, job.event), opts, result);
        result.applied.update += 1;
      }
    } catch (error) {
      result.failures.push(failureRecord(job.operation, job.event, error));
    }
  });

  if (result.failures.length) {
    throw new CalendarSyncError('CALENDAR_SYNC_UPSERT_FAILED', 'upsert', result);
  }

  if (result.deferred.upsert > 0) {
    result.partial = true;
    result.ok = true;
    return result;
  }

  const remainingBudget = Number.isFinite(mutationBudget)
    ? Math.max(0, mutationBudget - scheduledUpserts.length)
    : Number.POSITIVE_INFINITY;
  const scheduledDeletes = stale.slice(0, remainingBudget);
  result.deferred.delete = stale.length - scheduledDeletes.length;
  await mapBounded(scheduledDeletes, opts.concurrency, async (event) => {
    try {
      await callWithRetry(async () => {
        try {
          const response = await opts.deleteEvent(event.id);
          const status = responseStatus(response);
          if (status === 404 || status === 410) return { status: 204 };
          return response;
        } catch (error) {
          const status = responseStatus(error);
          if (status === 404 || status === 410) return { status: 204 };
          throw error;
        }
      }, opts, result);
      result.applied.delete += 1;
    } catch (error) {
      result.failures.push(failureRecord('delete', event, error));
    }
  });
  if (result.failures.length) {
    throw new CalendarSyncError('CALENDAR_SYNC_DELETE_FAILED', 'delete', result);
  }
  result.partial = result.deferred.delete > 0;
  result.ok = true;
  return result;
}

async function reconcileAll(options) {
  const opts = options || {};
  const calendars = opts.calendars || {};
  const shared = {
    sites: opts.sites,
    dryRun: opts.dryRun,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    baseDelayMs: opts.baseDelayMs,
    sleep: opts.sleep,
    deadlineAt: opts.deadlineAt,
    minimumRemainingMs: opts.minimumRemainingMs,
    mutationBudget: opts.mutationBudget
  };
  const detail = await reconcileCalendar(Object.assign({}, shared, calendars.detail, { mode: 'detail' }));
  const simple = await reconcileCalendar(Object.assign({}, shared, calendars.simple, { mode: 'simple' }));
  const totals = {
    planned: {},
    applied: {},
    deferred: {
      upsert: detail.deferred.upsert + simple.deferred.upsert,
      delete: detail.deferred.delete + simple.deferred.delete,
    },
    partial: detail.partial || simple.partial,
    retries: detail.retries + simple.retries
  };
  ['create', 'update', 'delete', 'unchanged'].forEach((key) => {
    totals.planned[key] = detail.planned[key] + simple.planned[key];
    totals.applied[key] = detail.applied[key] + simple.applied[key];
  });
  return {
    ok: detail.ok && simple.ok,
    dryRun: !!opts.dryRun,
    partial: detail.partial || simple.partial,
    detail,
    simple,
    totals
  };
}

module.exports = {
  SOURCE,
  SCHEMA,
  CalendarSyncError,
  stableEventId,
  isStrictDate,
  validateActiveSnapshot,
  buildDesiredEvents,
  isManagedEvent,
  ownershipOf,
  eventNeedsUpdate,
  reconcileCalendar,
  reconcileAll
};
