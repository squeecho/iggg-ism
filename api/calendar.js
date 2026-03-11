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

/* ── 허용된 Origin 확인 ── */
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser requests
  const allowed = [
    'https://iggg-total-schedule.vercel.app',
    'http://localhost',
    'http://127.0.0.1',
  ];
  return allowed.some((a) => origin.startsWith(a));
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

/* ── Vercel Serverless Handler ── */
module.exports = async (req, res) => {
  // CORS 헤더
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;

    if (!email || !privateKeyRaw) {
      return res.status(500).json({ error: 'Service account not configured' });
    }

    // Vercel 환경변수의 \n 문자열을 실제 줄바꿈으로 변환
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

    const { action, calendarId, method, path, body: reqBody, query } = req.body;

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
      const result = await callCalendarAPI(token, apiMethod, apiPath, reqBody || null);

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
