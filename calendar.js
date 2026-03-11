/**
 * Vercel Serverless Function — Google Calendar API (Service Account)
 * 
 * 서비스 계정 JWT → Access Token → Calendar API 호출
 * 외부 라이브러리 없이 Node.js 내장 crypto 모듈만 사용
 * 
 * 환경변수:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL — 서비스 계정 이메일
 *   GOOGLE_PRIVATE_KEY           — RSA 비밀키 (PEM)
 *   GCAL_ID_DETAIL               — 상세 캘린더 ID
 *   GCAL_ID_SIMPLE               — 간략 캘린더 ID
 */

const crypto = require('crypto');
const https = require('https');

/* ─── 토큰 캐시 (콜드스타트 간 유지, 웜 인스턴스에서 재사용) ─── */
let _cachedToken = null;
let _tokenExpiry = 0;

/* ─── JWT 생성 ─── */
function createJWT(email, privateKeyPem, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: scopes,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = b64url(header);
  const payloadB64 = b64url(payload);
  const sigInput = headerB64 + '.' + payloadB64;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const signature = sign.sign(privateKeyPem, 'base64url');

  return sigInput + '.' + signature;
}

/* ─── Access Token 교환 ─── */
function getAccessToken(email, privateKeyPem) {
  return new Promise((resolve, reject) => {
    // 캐시된 토큰이 아직 유효하면 재사용 (2분 여유)
    if (_cachedToken && Date.now() < _tokenExpiry - 120000) {
      return resolve(_cachedToken);
    }

    const jwt = createJWT(email, privateKeyPem, 'https://www.googleapis.com/auth/calendar');
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString();

    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            _cachedToken = json.access_token;
            _tokenExpiry = Date.now() + (json.expires_in || 3600) * 1000;
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

/* ─── Google Calendar API 호출 헬퍼 ─── */
function callCalendarAPI(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'www.googleapis.com',
      path: '/calendar/v3' + path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      }
    };
    if (bodyStr && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, data: data ? safeJSON(data) : null });
      });
    });
    req.on('error', reject);
    if (bodyStr && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function safeJSON(str) {
  try { return JSON.parse(str); } catch { return str; }
}

/* ─── 캘린더 ID 조회 ─── */
function getCalendarId(mode) {
  if (mode === 'simple') return process.env.GCAL_ID_SIMPLE || '';
  return process.env.GCAL_ID_DETAIL || '';
}

/* ─── 메인 핸들러 ─── */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;

    if (!email || !privateKey) {
      return res.status(500).json({ error: 'Service account not configured' });
    }

    // Vercel 환경변수에서 \n이 리터럴 문자열로 들어올 수 있음
    privateKey = privateKey.replace(/\\n/g, '\n');

    const token = await getAccessToken(email, privateKey);

    /* ─── GET: 이벤트 목록 조회 (iggg-ism 태그) ─── */
    if (req.method === 'GET') {
      const mode = req.query.mode || 'detail';
      const calId = req.query.calendarId || getCalendarId(mode);
      if (!calId) return res.status(400).json({ error: 'No calendarId' });

      const path = '/calendars/' + encodeURIComponent(calId)
        + '/events?privateExtendedProperty=src%3Diggg-ism&maxResults=2500&showDeleted=false';
      const result = await callCalendarAPI(token, 'GET', path);
      return res.status(result.status).json(result.data);
    }

    /* ─── POST: 이벤트 생성 / 일괄 처리 ─── */
    if (req.method === 'POST') {
      const { action, mode, calendarId, events, pns } = req.body || {};
      const calId = calendarId || getCalendarId(mode);
      if (!calId) return res.status(400).json({ error: 'No calendarId' });

      /* action: 'create' — 이벤트 배열 생성 */
      if (action === 'create' && Array.isArray(events)) {
        const results = [];
        for (const evt of events) {
          const path = '/calendars/' + encodeURIComponent(calId) + '/events';
          const r = await callCalendarAPI(token, 'POST', path, evt);
          results.push({ status: r.status, id: r.data?.id || null });
          // Rate limit 대응: 약간의 딜레이
          if (r.status === 429) {
            await new Promise(ok => setTimeout(ok, 2000));
            const retry = await callCalendarAPI(token, 'POST', path, evt);
            results[results.length - 1] = { status: retry.status, id: retry.data?.id || null };
          }
        }
        return res.status(200).json({ ok: true, results });
      }

      /* action: 'delete' — 특정 이벤트 ID 배열 삭제 */
      if (action === 'delete' && Array.isArray(events)) {
        const results = [];
        for (const eventId of events) {
          const path = '/calendars/' + encodeURIComponent(calId) + '/events/' + eventId;
          const r = await callCalendarAPI(token, 'DELETE', path);
          results.push({ status: r.status, id: eventId });
          if (r.status === 429) {
            await new Promise(ok => setTimeout(ok, 2000));
            await callCalendarAPI(token, 'DELETE', path);
          }
        }
        return res.status(200).json({ ok: true, results });
      }

      /* action: 'deleteBySite' — pn 목록으로 이벤트 찾아서 삭제 */
      if (action === 'deleteBySite' && Array.isArray(pns)) {
        // 1) iggg-ism 태그 이벤트 전체 조회
        const listPath = '/calendars/' + encodeURIComponent(calId)
          + '/events?privateExtendedProperty=src%3Diggg-ism&maxResults=2500&showDeleted=false';
        const listResult = await callCalendarAPI(token, 'GET', listPath);
        const allItems = listResult.data?.items || [];

        // 2) pn 매칭 필터
        const toDelete = allItems.filter(ev => {
          const priv = ev.extendedProperties?.private || {};
          const sum = ev.summary || '';
          return pns.some(pn => {
            if (priv.pn) return priv.pn === pn;
            const region = pn.indexOf(' ') > 0 ? pn.slice(0, pn.indexOf(' ')) : pn;
            return sum === pn || sum.startsWith(pn + ' |') || sum.startsWith(region + ' |');
          });
        });

        // 3) 순차 삭제
        const deleted = [];
        for (const ev of toDelete) {
          const path = '/calendars/' + encodeURIComponent(calId) + '/events/' + ev.id;
          const r = await callCalendarAPI(token, 'DELETE', path);
          deleted.push(ev.id);
          if (r.status === 429) {
            await new Promise(ok => setTimeout(ok, 2000));
            await callCalendarAPI(token, 'DELETE', path);
          }
        }
        return res.status(200).json({ ok: true, deleted });
      }

      /* action: 'sync' — 현장 데이터 받아서 기존 삭제 후 재생성 (일괄 동기화) */
      if (action === 'sync') {
        const { sites, mode: syncMode } = req.body;
        const syncCalId = calendarId || getCalendarId(syncMode);
        if (!syncCalId || !Array.isArray(sites)) {
          return res.status(400).json({ error: 'Invalid sync request' });
        }

        const sitePns = sites.map(s => s.pn).filter(Boolean);

        // 1) 기존 이벤트 삭제
        if (sitePns.length) {
          const listPath = '/calendars/' + encodeURIComponent(syncCalId)
            + '/events?privateExtendedProperty=src%3Diggg-ism&maxResults=2500&showDeleted=false';
          const listResult = await callCalendarAPI(token, 'GET', listPath);
          const allItems = listResult.data?.items || [];
          const toDelete = allItems.filter(ev => {
            const priv = ev.extendedProperties?.private || {};
            const sum = ev.summary || '';
            return sitePns.some(pn => {
              if (priv.pn) return priv.pn === pn;
              const region = pn.indexOf(' ') > 0 ? pn.slice(0, pn.indexOf(' ')) : pn;
              return sum === pn || sum.startsWith(pn + ' |') || sum.startsWith(region + ' |');
            });
          });
          for (const ev of toDelete) {
            const delPath = '/calendars/' + encodeURIComponent(syncCalId) + '/events/' + ev.id;
            const r = await callCalendarAPI(token, 'DELETE', delPath);
            if (r.status === 429) await new Promise(ok => setTimeout(ok, 2000));
          }
        }

        // 2) 새 이벤트 생성
        const created = [];
        for (const site of sites) {
          const evts = buildEvents(site, syncMode);
          for (const evt of evts) {
            const createPath = '/calendars/' + encodeURIComponent(syncCalId) + '/events';
            const r = await callCalendarAPI(token, 'POST', createPath, evt);
            created.push({ pn: site.pn, id: r.data?.id, status: r.status });
            if (r.status === 429) {
              await new Promise(ok => setTimeout(ok, 2000));
              const retry = await callCalendarAPI(token, 'POST', createPath, evt);
              created[created.length - 1] = { pn: site.pn, id: retry.data?.id, status: retry.status };
            }
          }
        }
        return res.status(200).json({ ok: true, created });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    /* ─── DELETE: 단일 이벤트 삭제 ─── */
    if (req.method === 'DELETE') {
      const { calendarId: delCalId, eventId, mode: delMode } = req.query || {};
      const calId = delCalId || getCalendarId(delMode);
      if (!calId || !eventId) return res.status(400).json({ error: 'Missing calendarId or eventId' });
      const path = '/calendars/' + encodeURIComponent(calId) + '/events/' + eventId;
      const result = await callCalendarAPI(token, 'DELETE', path);
      return res.status(result.status).json({ ok: result.status < 300 || result.status === 404 });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[calendar API error]', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};


/* ─── 이벤트 빌드 유틸 ─── */

const TASK_SHORT = {
  '가설공사':'가설','철거공사':'철거','소방공사':'소방',
  '목공사':'목공','전기공사':'전기','도장공사':'도장',
  '금속공사':'금속','설비공사':'설비','타일공사':'타일',
  '공조공사':'공조','필름공사':'필름','가스공사':'가스',
  '기타공사':'기타','준공청소':'청소'
};
const GCAL_COLOR_IDS = ['4','5','6','7','8','10','11'];

function gcalColorId(pn) {
  if (!pn) return '7';
  let h = 0;
  for (let i = 0; i < pn.length; i++) h = Math.imul(h, 31) + pn.charCodeAt(i) | 0;
  return GCAL_COLOR_IDS[Math.abs(h) % GCAL_COLOR_IDS.length];
}

function gcalRegion(pn) {
  if (!pn) return '';
  const idx = pn.indexOf(' ');
  return idx > 0 ? pn.slice(0, idx) : pn;
}

function addDay(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildEvents(site, mode) {
  const pn = site.pn || '';
  const colorId = gcalColorId(pn);
  const events = [];

  if (mode === 'simple') {
    /* 간략: 현장명 + 총 기간 1개 이벤트 */
    let sd = site.sd || '';
    let ed = site.ed || '';
    if (!sd || !ed) {
      (site.tasks || []).filter(t => t.on && t.sd && t.ed).forEach(t => {
        if (!sd || t.sd < sd) sd = t.sd;
        if (!ed || t.ed > ed) ed = t.ed;
        if (t.split && t.sd2 && t.ed2) {
          if (t.sd2 < sd) sd = t.sd2;
          if (t.ed2 > ed) ed = t.ed2;
        }
      });
    }
    if (sd && ed) {
      events.push({
        summary: pn,
        description: pn + ' 공사 전체 기간',
        start: { date: sd },
        end: { date: addDay(ed, 1) },
        colorId,
        extendedProperties: { private: { src: 'iggg-ism', pn } }
      });
    }
  } else {
    /* 상세: 공종별 이벤트 */
    const tasks = (site.tasks || []).filter(t => t.on && t.sd && t.ed);
    for (const t of tasks) {
      let vendor = '';
      if (Array.isArray(t.contractors)) {
        for (const c of t.contractors) {
          if (c && c.trim()) { vendor = c.trim(); break; }
        }
      }
      const region = gcalRegion(pn);
      const taskShort = TASK_SHORT[t.name] || t.name || '';
      const title = region + ' | ' + taskShort + (vendor ? ' | ' + vendor : '');
      const desc = pn + ' 공사 일정\n공종: ' + t.name + (vendor ? '\n업체: ' + vendor : '');

      events.push({
        summary: title,
        description: desc,
        start: { date: t.sd },
        end: { date: addDay(t.ed, 1) },
        colorId,
        extendedProperties: { private: { src: 'iggg-ism', pn } }
      });

      if (t.split && t.sd2 && t.ed2) {
        events.push({
          summary: title + ' (2차)',
          description: desc + '\n(2차 일정)',
          start: { date: t.sd2 },
          end: { date: addDay(t.ed2, 1) },
          colorId,
          extendedProperties: { private: { src: 'iggg-ism', pn } }
        });
      }
    }
  }

  return events;
}
