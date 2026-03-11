/**
 * Vercel Serverless Function — ICS 캘린더 피드
 * 
 * URL: https://iggg-ism.vercel.app/api/calendar
 *      https://iggg-ism.vercel.app/calendar.ics  (vercel.json rewrite)
 * 
 * Firebase Firestore에서 확정 현장 데이터를 읽어 ICS 형식으로 변환합니다.
 * 직원들이 이 URL을 캘린더 앱에 구독하메 자동 갱신됩니다.
 * 
 * 쿼리 파라미터:
 *   ?site=현장명    — 특정 현장만 포함
 *   ?mode=simple   — 현장별 하나의 이벤트 (공사 전체기간)
 *   (기본: 공종별 상세 이벤트)
 */

const FIREBASE_PROJECT = 'iggg-schedule';
const FIREBASE_API_KEY = 'AIzaSyAks6Jg7KiIOv9rWmAlnXcC8vEnNZvDbDo';

const TASK_SHORT = {
  '가설공사':'가설','철거공사':'철거','소방공사':'소방',
  '목공사':'목공','전기공사':'전기','도장공사':'도장',
  '금속공사':'금속','설비공사':'설비','타일공사':'타일',
  '공조공사':'공조','필름공사':'필름','가스공사':'가스',
  '기타공사':'기타','준공청소':'청소'
};

/* ── 현장별 색상 (Google Calendar colorId와 동일 매핑) ── */
const SITE_COLORS = [
  { name: 'Flamingo',  hex: '#E67C73' },
  { name: 'Banana',    hex: '#F6BF26' },
  { name: 'Tangerine', hex: '#F4511E' },
  { name: 'Peacock',   hex: '#039BE5' },
  { name: 'Graphite',  hex: '#616161' },
  { name: 'Basil',     hex: '#0B8043' },
  { name: 'Tomato',    hex: '#D50000' },
];

function getSiteColor(pn) {
  if (!pn) return SITE_COLORS[3]; // Peacock default
  let h = 0;
  for (let i = 0; i < pn.length; i++) h = Math.imul(h, 31) + pn.charCodeAt(i) | 0;
  return SITE_COLORS[Math.abs(h) % SITE_COLORS.length];
}

/* ── Firestore REST API에서 전체 sites 컬렉션 로드 ── */
async function loadSites() {
  const docs = [];
  let pageToken = '';
  
  for (let i = 0; i < 20; i++) { // 최대 20페이지 (안전장치)
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/sites?key=${FIREBASE_API_KEY}&pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Firestore fetch failed: ' + r.status);
    const data = await r.json();
    if (data.documents) docs.push(...data.documents);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  
  return docs.map(parseFirestoreDoc).filter(s => s && s.pn);
}

/* ── Firestore 문서 → 일반 JS 객체 변환 ── */
function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  return parseFirestoreValue({ mapValue: { fields: doc.fields } });
}

function parseFirestoreValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(parseFirestoreValue);
  }
  if ('mapValue' in v) {
    const obj = {};
    const fields = v.mapValue.fields || {};
    for (const key in fields) {
      obj[key] = parseFirestoreValue(fields[key]);
    }
    return obj;
  }
  return null;
}

/* ── 날짜 유틸 ── */
function addDay(dateStr, n) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function toICSDate(dateStr) {
  // YYYY-MM-DD → YYYYMMDD (VALUE=DATE 형식)
  return (dateStr || '').replace(/-/g, '');
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
}

/* ── 지역 추출 (현장명에서 첫 공백 전) ── */
function getRegion(pn) {
  if (!pn) return '';
  const idx = pn.indexOf(' ');
  return idx > 0 ? pn.slice(0, idx) : pn;
}

/* ── ICS 이벤트 하나 생성 ── */
function makeEvent(uid, summary, description, dtStart, dtEnd, color) {
  // ICS의 DTEND는 exclusive (종료일 다음날)
  const endExclusive = addDay(dtEnd, 1);
  
  const lines = [
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + nowStamp(),
    'DTSTART;VALUE=DATE:' + toICSDate(dtStart),
    'DTEND;VALUE=DATE:' + toICSDate(endExclusive),
    'SUMMARY:' + escapeICS(summary),
  ];
  if (description) {
    lines.push('DESCRIPTION:' + escapeICS(description));
  }
  if (color) {
    lines.push('COLOR:' + color.hex);
    lines.push('X-APPLE-CALENDAR-COLOR:' + color.hex);
    lines.push('CATEGORIES:' + color.name);
  }
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function escapeICS(str) {
  return (str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/* ── 현장 하나 → 이벤트 배열 (상세 모드) ── */
function siteToDetailEvents(site) {
  const events = [];
  const pn = site.pn || '';
  const region = getRegion(pn);
  const color = getSiteColor(pn);
  const tasks = (site.tasks || []).filter(t => t.on && t.sd && t.ed);
  
  tasks.forEach(t => {
    const short = TASK_SHORT[t.name] || t.name || '';
    const vendor = (t.contractors || []).find(c => c && c.trim()) || '';
    const summary = region + ' | ' + short + (vendor ? ' | ' + vendor : '');
    const desc = pn + ' 공사 일정\n공종: ' + t.name + (vendor ? '\n업체: ' + vendor : '');
    const uid = 'igism-' + encodeURIComponent(pn) + '-t' + t.id + '@iggg-ism.vercel.app';
    
    events.push(makeEvent(uid, summary, desc, t.sd, t.ed, color));
    
    // 2차 분리 일정
    if (t.split && t.sd2 && t.ed2) {
      const uid2 = uid.replace('@', '-p2@');
      const desc2 = t.desc2 || t.name;
      const summary2 = region + ' | ' + short + '(2차)' + (vendor ? ' | ' + vendor : '');
      events.push(makeEvent(uid2, summary2, desc + '\n(2차: ' + desc2 + ')', t.sd2, t.ed2, color));
    }
    
    // 3차 분리 일정
    if (t.split3 && t.sd3 && t.ed3) {
      const uid3 = uid.replace('@', '-p3@');
      const desc3 = t.desc3 || t.name;
      const summary3 = region + ' | ' + short + '(3차)' + (vendor ? ' | ' + vendor : '');
      events.push(makeEvent(uid3, summary3, desc + '\n(3차: ' + desc3 + ')', t.sd3, t.ed3, color));
    }
  });
  
  // 비고 (notes) — 날짜가 있는 항목만
  (site.notes || []).forEach(n => {
    if (!n.label || !n.dt) return;
    const uid = 'igism-' + encodeURIComponent(pn) + '-n' + n.id + '@iggg-ism.vercel.app';
    const summary = region + ' | ' + n.label;
    events.push(makeEvent(uid, summary, pn + ' · ' + n.label, n.dt, n.dt, color));
  });
  
  return events;
}

/* ── 현장 하나 → 이벤트 하나 (ꂄ략 모드) ── */
function siteToSimpleEvent(site) {
  const pn = site.pn || '';
  if (!site.sd || !site.ed) return null;
  const color = getSiteColor(pn);
  const uid = 'igism-simple-' + encodeURIComponent(pn) + '@iggg-ism.vercel.app';
  const summary = '🔨 ' + pn;
  const desc = pn + ' 공사\n기간: ' + site.sd + ' ~ ' + site.ed;
  return makeEvent(uid, summary, desc, site.sd, site.ed, color);
}

/* ── 메인 핸들러 ── */
module.exports = async function handler(req, res) {
  try {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // 캐시: 10분 (캘린더 앱이 너무 자주 요청하는 것 방지)
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="ig-schedule.ics"');
    
    const { site: filterSite, mode } = req.query || {};
    const isSimple = mode === 'simple';
    
    // Firestore에서 데이터 로드
    const allSites = await loadSites();
    
    // 확정 현장만 필터
    let sites = allSites.filter(s => s.confirmed);
    
    // 특정 현장 필터
    if (filterSite) {
      sites = sites.filter(s => s.pn === filterSite);
    }
    
    // ICS 생성
    const events = [];
    sites.forEach(site => {
      if (isSimple) {
        const evt = siteToSimpleEvent(site);
        if (evt) events.push(evt);
      } else {
        events.push(...siteToDetailEvents(site));
      }
    });
    
    const calName = isSimple ? 'IG 공정표 (ꄄ략)' : '!G 공정표 (상세)';
    
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//IGGG ISM//Construction Schedule//KO',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:' + calName,
      'X-WR-TIMEZONE:Asia/Seoul',
      'REFRESH-INTERVAL;VALUE=DURATION:PT10M',
      'X-PUBLISHED-TTL:PT10M',
      ...events,
      'END:VCALENDAR'
    ].join('\r\n');
    
    res.status(200).send(ics);
    
  } catch (err) {
    console.error('ICS generation error:', err);
    res.status(500).send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR');
  }
};
