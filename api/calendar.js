/**
 * Vercel Serverless Function: Google Calendar API Proxy
 * 서비스 계정(Service Account)을 이용해 Google Calendar API를 호출하는 프록시
 *
 * 환경변수 필요:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — 서비스 계정 이메일
 *   GOOGLE_PRIVATE_KEY            — 서비스 계정 비밀키 (PEM)
 *   GCAL_ID_DETAIL                — 상세 캘린더 ID
 *   GCAL_ID_SIMPLE                — 간략 캘린더 ID
 */

const crypto = require('crypto');
const https = require('https');

/* ── 토큰 캐시 (서버리스 인스턴스 수명 동안 재사용) ── */
let _cachedToken = null;
let _tokenExpiry = 0;

/* ── Base64url 인코딩 ── */
function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/* ── JWT 생성 ── */
function createJWT(email, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];
  const signInput = segments.join('.');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(privateKey, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return signInput + '.' + signature;
}

/* ── Google OAuth2 토큰 교환 ── */
function getAccessToken(email, privateKey) {
  return new Promise((resolve, reject) => {
    // 캐시된 토큰이 유효하면 재사용
    if (_cachedToken && Date.now() < _tokenExpiry) {
      return resolve(_cachedToken);
    }

    const jwt = createJWT(email, privateKey);
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      res.setEncoding('utf8'); /* 멀티바이트 청크 분절 안전 디코딩 */
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _cachedToken = json.access_token;
            // 만료 2분 전에 갱신하도록
            _tokenExpiry = Date.now() + (json.expires_in - 120) * 1000;
            resolve(json.access_token);
          } else {
            reject(new Error('Token error: ' + data));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Google Calendar API 호출 ── */
function callCalendarAPI(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';

    const options = {
      hostname: 'www.googleapis.com',
      path: '/calendar/v3/' + path,
      method: method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
    };

    if (bodyStr && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      /* 한글(멀티바이트)이 청크 경계에서 잘리면 U+FFFD로 깨짐 →
         setEncoding은 내부 StringDecoder로 경계를 보존한다 */
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    if (bodyStr && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/* ── 허용된 Origin 확인 ──
   전수감사 2026-07-28: ①무Origin(=curl 등 비브라우저)이 무조건 통과해 서비스
   계정 캘린더를 무인증 조작 가능 ②목록이 폐도메인 ③startsWith 는
   evil.com 접두 위장 통과. → 무Origin 차단 + 현행 도메인 정확 일치.
   (Origin 은 위조 가능하므로 완전한 인증은 아님 — 서명 토큰 도입은 백로그) */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  const allowed = [
    'https://ism.igggstudio.com',
    'https://iggg-ism.vercel.app',
  ];
  if (allowed.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/* ── 캘린더 ID 매핑 ── */
function resolveCalendarId(alias) {
  if (alias === 'detail') return process.env.GCAL_ID_DETAIL || 'primary';
  if (alias === 'simple') return process.env.GCAL_ID_SIMPLE || 'primary';
  // 직접 지정된 캘린더 ID도 허용 (환경변수와 일치하는 경우만)
  const detailId = process.env.GCAL_ID_DETAIL || '';
  const simpleId = process.env.GCAL_ID_SIMPLE || '';
  if (alias === detailId || alias === simpleId) return alias;
  // 그 외는 거부 (보안)
  return null;
}

/* ══════════════════════════════════════════════════════════════════
   ICS(iCalendar) 구독 피드 — RFC 5545
   캘린더 앱(iOS/구글/아웃룩)이 주기적으로 GET 하는 읽기 전용 공개 피드.
   ══════════════════════════════════════════════════════════════════ */

/* 쿼리 파싱: Vercel 은 req.query 를 채워주지만, rewrite 목적지 쿼리·로컬 실행
   양쪽에서 안전하도록 URL 파싱 결과와 병합한다. */
function parseQuery(req) {
  const out = {};
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    u.searchParams.forEach(function (v, k) { out[k] = v; });
  } catch (e) { /* ignore */ }
  if (req.query && typeof req.query === 'object' && !Array.isArray(req.query)) {
    Object.keys(req.query).forEach(function (k) {
      const v = req.query[k];
      out[k] = Array.isArray(v) ? v[0] : v;
    });
  }
  return out;
}

/* TEXT 값 이스케이프 (RFC 5545 §3.3.11): \ ; , 개행 */
function icsEscape(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/* 줄 접기 (RFC 5545 §3.1): 한 줄 75 옥텟 초과 시 CRLF + 공백 1칸으로 이어붙인다.
   한글(UTF-8 3바이트)이 옥텟 경계에서 쪼개지면 캘린더 앱이 깨진 글자를 보이므로
   길이는 옥텟으로 세되 끊는 단위는 문자(코드포인트)로 한다. */
function icsFold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const chars = Array.from(line);
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const n = Buffer.byteLength(ch, 'utf8');
    if (curBytes + n > 75) {
      out.push(cur);
      cur = ' ' + ch;      /* 이어지는 줄은 반드시 공백 1칸으로 시작 */
      curBytes = 1 + n;
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}

/* 2026-07-28 → 20260728 */
function icsDateOnly(d) {
  return String(d || '').slice(0, 10).replace(/-/g, '');
}

/* ISO 문자열/Date → 20260728T003000Z (UTC 고정 → VTIMEZONE 불필요) */
function icsUtc(dt) {
  const d = new Date(dt);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/* YYYY-MM-DD + n일 */
function icsAddDays(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Google Calendar events.list 아이템 배열 → VCALENDAR 텍스트 */
function buildIcs(events, opts) {
  opts = opts || {};
  const stamp = icsUtc(opts.now == null ? Date.now() : opts.now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//iggg studio//IG ISM Schedule//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEscape(opts.calName || '!G 공정표'),
    'X-WR-CALDESC:' + icsEscape(opts.calDesc || '이견공간기획사무소 현장 공정표'),
    'X-WR-TIMEZONE:Asia/Seoul',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  (events || []).forEach(function (ev, idx) {
    if (!ev || ev.status === 'cancelled') return;
    const st = ev.start || {};
    const en = ev.end || {};
    let dtStart, dtEnd;

    if (st.date) {
      /* 종일 일정 — DTEND 는 배타적(exclusive). 구글도 배타적으로 준다. */
      dtStart = 'DTSTART;VALUE=DATE:' + icsDateOnly(st.date);
      dtEnd = 'DTEND;VALUE=DATE:' + icsDateOnly(en.date || icsAddDays(st.date, 1));
    } else if (st.dateTime) {
      const s = icsUtc(st.dateTime);
      if (!s) return;
      const e = en.dateTime ? icsUtc(en.dateTime) : null;
      dtStart = 'DTSTART:' + s;
      dtEnd = 'DTEND:' + (e || s);
    } else {
      return; /* 시작 없는 이벤트는 건너뜀 */
    }

    /* UID: 구독 갱신 시 같은 일정으로 인식되도록 안정적인 값 사용 */
    const uid = String(ev.iCalUID || (ev.id ? ev.id + '@ism.igggstudio.com' : 'ism-' + idx + '@ism.igggstudio.com'))
      .replace(/[\r\n]/g, '');

    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + uid);
    lines.push('DTSTAMP:' + stamp);
    lines.push(dtStart);
    lines.push(dtEnd);
    lines.push('SUMMARY:' + icsEscape(ev.summary || '(제목 없음)'));
    if (ev.description) lines.push('DESCRIPTION:' + icsEscape(ev.description));
    if (ev.location) lines.push('LOCATION:' + icsEscape(ev.location));
    if (ev.updated) {
      const lm = icsUtc(ev.updated);
      if (lm) lines.push('LAST-MODIFIED:' + lm);
    }
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/* 이벤트 전량 수집 (페이지네이션) */
async function fetchAllEvents(token, calId, timeMin, timeMax) {
  const events = [];
  let pageToken = '';
  for (let i = 0; i < 10; i++) {
    let q = 'timeMin=' + encodeURIComponent(timeMin)
      + '&timeMax=' + encodeURIComponent(timeMax)
      + '&singleEvents=true&orderBy=startTime&showDeleted=false&maxResults=2500';
    if (pageToken) q += '&pageToken=' + encodeURIComponent(pageToken);
    const result = await callCalendarAPI(
      token, 'GET', 'calendars/' + encodeURIComponent(calId) + '/events?' + q, null
    );
    if (result.status !== 200) {
      throw new Error('Calendar API ' + result.status + ': ' + String(result.body).slice(0, 300));
    }
    const json = JSON.parse(result.body);
    (json.items || []).forEach(function (it) { events.push(it); });
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return events;
}

/* GET /api/calendar?action=ics&cal=detail|simple
   ※ Origin 게이트 예외 — 캘린더 앱 구독 요청에는 Origin 헤더가 없다.
     읽기 전용(쓰기·삭제 불가)이라 공개해도 조작 위험이 없으며,
     POST 프록시 게이트는 그대로 유지된다. */
async function handleIcs(req, res, q) {
  const alias = q.cal === 'simple' ? 'simple' : 'detail';
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
    if (!email || !privateKeyRaw) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(500).send('Service account not configured');
    }
    const calId = alias === 'simple' ? process.env.GCAL_ID_SIMPLE : process.env.GCAL_ID_DETAIL;
    if (!calId) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(500).send('Calendar not configured: ' + alias);
    }

    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
    const now = Date.now();
    const DAY = 86400000;
    const timeMin = new Date(now - 30 * DAY).toISOString();
    const timeMax = new Date(now + 180 * DAY).toISOString();

    const token = await getAccessToken(email, privateKey);
    const events = await fetchAllEvents(token, calId, timeMin, timeMax);

    const ics = buildIcs(events, {
      now: now,
      calName: alias === 'simple' ? '!G 공정표 (요약)' : '!G 공정표 (상세)',
      calDesc: alias === 'simple'
        ? '이견공간기획사무소 — 현장별 전체 공사기간'
        : '이견공간기획사무소 — 현장 공종별 일정',
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Disposition',
      'inline; filename="' + (alias === 'simple' ? 'calendar-simple.ics' : 'calendar.ics') + '"');
    res.setHeader('Access-Control-Allow-Origin', '*'); /* 읽기 전용 공개 피드 */
    return res.status(200).send(ics);
  } catch (err) {
    console.error('[api/calendar][ics] Error:', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send('ICS generation failed');
  }
}

/* ── Vercel Serverless Handler ── */
module.exports = async (req, res) => {
  const query = parseQuery(req);

  /* ICS 구독 피드는 Origin 게이트 이전에 처리 (읽기 전용 공개) */
  if (req.method === 'GET' && query.action === 'ics') {
    return handleIcs(req, res, query);
  }

  // CORS 헤더
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS 헤더만으론 실행 자체는 못 막는다 — 비허용 Origin 은 처리 전 차단
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

    if (!email || !privateKeyRaw) {
      return res.status(500).json({ error: 'Service account not configured' });
    }

    // Vercel 환경변수의 \n 문자열을 실제 줄바꿈으로 변환
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

    const { action, calendarId, method, path, body: reqBody, bodyB64, query } = req.body;

    /* bodyB64: 프론트가 이벤트 본문을 base64(ASCII)로 무장해 전송 —
       전송/파싱 계층의 멀티바이트 분절로 한글이 U+FFFD로 오염되는 것을 차단 */
    let proxyBody = reqBody || null;
    if (bodyB64) {
      try {
        proxyBody = JSON.parse(Buffer.from(bodyB64, 'base64').toString('utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'Invalid bodyB64' });
      }
    }

    /* ── action: 'config' — 프론트엔드에서 캘린더 ID 조회 ── */
    if (action === 'config') {
      return res.status(200).json({
        detailCalId: process.env.GCAL_ID_DETAIL || '',
        simpleCalId: process.env.GCAL_ID_SIMPLE || '',
      });
    }

    /* ── action: 'proxy' — Calendar API 프록시 ── */
    if (action === 'proxy') {
      // 캘린더 ID 검증
      const resolvedCalId = resolveCalendarId(calendarId);
      if (!resolvedCalId) {
        return res.status(403).json({ error: 'Calendar ID not allowed' });
      }

      // 토큰 발급
      const token = await getAccessToken(email, privateKey);

      // API 경로 조립
      // path 예: '/events', '/events/{eventId}'
      let apiPath = 'calendars/' + encodeURIComponent(resolvedCalId) + (path || '/events');
      if (query) {
        apiPath += (apiPath.includes('?') ? '&' : '?') + query;
      }

      // Calendar API 호출
      const apiMethod = (method || 'GET').toUpperCase();
      const result = await callCalendarAPI(token, apiMethod, apiPath, proxyBody);

      // 응답 전달
      res.status(result.status);
      try {
        const jsonBody = JSON.parse(result.body);
        return res.json(jsonBody);
      } catch {
        return res.send(result.body);
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[api/calendar] Error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};

/* ── 로컬 검증용 내보내기 (Vercel 핸들러 동작에는 영향 없음) ── */
module.exports.buildIcs = buildIcs;
module.exports.icsFold = icsFold;
module.exports.icsEscape = icsEscape;
module.exports.parseQuery = parseQuery;
