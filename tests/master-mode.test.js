'use strict';

/* 보안 감사 2026-11-12 #8 — 마스터 모드 판정은 서버(action=master-check)가 한다.
   백엔드 /api/staff/me 응답은 https.request 를 가짜로 바꿔 흉내 낸다. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const calendarApi = require('../api/calendar.js');

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: undefined,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

/* /api/staff/me 를 토큰별로 흉내 — {token: {status, body}} */
function withStaffBackend(byToken, fn) {
  const original = https.request;
  const calls = [];
  https.request = function (opts, onResponse) {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = (error) => { req.emit('error', error); req.emit('close'); };
    req.end = () => {
      const auth = String((opts.headers || {}).Authorization || '');
      const token = auth.replace(/^Bearer\s+/i, '');
      calls.push({ path: opts.path, token: token });
      const reply = byToken[token] || { status: 401, body: '{}' };
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = reply.status;
        res.setEncoding = () => {};
        onResponse(res);
        res.emit('data', JSON.stringify(reply.body));
        res.emit('end');
        req.emit('close');
      });
    };
    return req;
  };
  return Promise.resolve().then(() => fn(calls)).finally(() => { https.request = original; });
}

function masterCheck(headers) {
  const res = fakeRes();
  return calendarApi(Object.assign({ method: 'POST', url: '/api/calendar', query: {} }, {
    headers: Object.assign({ origin: 'https://ism.igggstudio.com' }, headers || {}),
    body: { action: 'master-check' },
  }), res).then(() => res);
}

test('isMasterRole: owner 만 마스터, 나머지 역할·빈 값은 아니다', () => {
  assert.equal(calendarApi.isMasterRole('owner'), true);
  for (const role of ['exec', 'manager', 'staff', 'field', 'admin', '', null, undefined, 'Owner']) {
    assert.equal(calendarApi.isMasterRole(role), false, String(role));
  }
});

test('master-check: owner 로 승인된 계정만 master:true, 응답에 역할·이메일이 없다', () =>
  withStaffBackend({
    'tok-owner': { status: 200, body: { email: 'boss@example.com', status: 'approved', role: 'owner' } },
    'tok-exec': { status: 200, body: { email: 'e@example.com', status: 'approved', role: 'exec' } },
    'tok-staff': { status: 200, body: { email: 's@example.com', status: 'approved', role: 'staff' } },
    'tok-pending-owner': { status: 200, body: { email: 'p@example.com', status: 'pending', role: 'owner' } },
  }, async (calls) => {
    const owner = await masterCheck({ authorization: 'Bearer tok-owner' });
    assert.equal(owner.statusCode, 200);
    assert.deepEqual(owner.body, { ok: true, master: true });
    assert.equal(owner.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(owner.body).includes('boss@'), false);
    assert.ok(calls.some((c) => c.path === '/api/staff/me' && c.token === 'tok-owner'));

    for (const tok of ['tok-exec', 'tok-staff']) {
      const res = await masterCheck({ authorization: 'Bearer ' + tok });
      assert.equal(res.statusCode, 200, tok);
      assert.deepEqual(res.body, { ok: true, master: false }, tok);
    }

    /* 승인 전 계정은 역할이 owner 여도 게이트에서 막힌다 */
    const pending = await masterCheck({ authorization: 'Bearer tok-pending-owner' });
    assert.equal(pending.statusCode, 403);
    assert.equal(pending.headers['x-auth-denied'], '1');
  }));

test('master-check: 자격증명 없음 401, 거부된 토큰 401, 백엔드 장애 503 — 어느 쪽도 master 아님', () =>
  withStaffBackend({
    'tok-down': { status: 502, body: {} },
  }, async () => {
    const none = await masterCheck({});
    assert.equal(none.statusCode, 401);
    assert.equal(none.body.master, undefined);

    const rejected = await masterCheck({ authorization: 'Bearer tok-unknown' });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.body.master, undefined);

    const down = await masterCheck({ authorization: 'Bearer tok-down' });
    assert.equal(down.statusCode, 503);
    assert.equal(down.body.master, undefined);
  }));

test('master-check: 남의 출처는 Origin 게이트에서 403', async () => {
  const res = await masterCheck({ origin: 'https://evil.example', authorization: 'Bearer tok-owner' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.master, undefined);
});

test('화면 소스에 마스터 이메일·비밀번호 해시·비밀번호 입력 경로가 없다', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  for (const gone of [
    '_MASTER_HASH', '_MASTER_SSO_EMAILS', '_ssoIsMaster', '_sha256', 'masterPwInput',
    '_submitMaster', '_showMasterModal', "crypto.subtle.digest('SHA-256'",
    '48f225b82a33834d1850cff0faa53e44023775822fe9fcd200ece404d82ebc01',
  ]) {
    assert.equal(html.includes(gone), false, gone);
  }
  assert.equal(/[A-Za-z0-9._%+-]+@gmail\.com/.test(html), false, 'gmail 주소가 남아 있다');
  /* 마스터 진입은 서버 판정 하나뿐 */
  assert.match(html, /action:'master-check'/);
  assert.match(html, /onclick="_toggleMasterMode\(\)"/);
  const enterCalls = html.match(/(?<!function )_enterMasterMode\(\)/g) || [];
  assert.equal(enterCalls.length, 2, '진입 호출은 접속 시 판정·잠금 버튼 두 곳');
  assert.match(html, /ok===true&&!_masterMode\) _enterMasterMode\(\)/);
  assert.match(html, /if\(ok===true\)\{ _enterMasterMode\(\);/);
});

test('익명 로그인 폴백이 없고, 실패하면 로그인 안내를 띄운다 (#13)', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.equal(html.includes('signInAnonymously'), false);
  assert.equal(html.includes('_signInStaffOrAnon'), false);
  assert.match(html, /_signInStaff\(\)\s*\n\s*\.then/);
  assert.match(html, /_showStaffAuthNotice\(_staffAuthFailKind\(e\)\)/);
  assert.match(html, /www\.igggstudio\.com\/\?sso_return=/);
});

test('로그인 안내 분기: 쿠키 없음·토큰 거부·미승인은 로그인, 네트워크·서버 장애는 다시 시도', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const src = html.match(/function _staffAuthFailKind\(e\) \{[\s\S]*?\n\}/);
  assert.ok(src, '_staffAuthFailKind 를 찾지 못했다');
  const kind = new Function(src[0] + '\nreturn _staffAuthFailKind;')();
  assert.equal(kind(new Error('iggg_sso 쿠키 없음')), 'login');
  assert.equal(kind(new Error('securetoken 400')), 'login');
  assert.equal(kind(new Error('firestore-token 401')), 'login');
  assert.equal(kind(new Error('firestore-token 403')), 'login');
  assert.equal(kind(new Error('firestore-token 503')), 'retry');
  assert.equal(kind(new Error('securetoken 503')), 'retry');
  assert.equal(kind(new TypeError('Failed to fetch')), 'retry');
});
