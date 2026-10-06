import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';

let runtime;
let db;
let options;
let superToken;
let orgA;
let orgB;
let memberToken;
let memberId;

async function request(path, method = 'GET', data, token) {
  const response = await runtime.dispatchFetch('https://test.local' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { status: response.status, data: await response.json() };
}
async function signIn(code) {
  const result = await request('/auth/login', 'POST', { code });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function invite(orgId, token = superToken) {
  const result = await request('/invites', 'POST', { organization_id: orgId }, token);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.code;
}
async function migrate(sql) {
  let statement = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (!line.trim() || line.trim().startsWith('--')) continue;
    statement += line + '\n';
    if (/^CREATE TRIGGER/i.test(line.trim())) trigger = true;
    if (line.trim().endsWith(';') && (!trigger || /^END;/i.test(line.trim()))) {
      await db.prepare(statement).run();
      statement = '';
      trigger = false;
    }
  }
  assert.equal(statement.trim(), '');
}

before(async () => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  options = {
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-09-30', d1Databases: ['DB'],
    bindings: { APP_ENV: 'production', WECHAT_APP_ID: 'test-app', WECHAT_APP_SECRET: 'test-only-secret',
      SESSION_SECRET: 'test-only-session-secret-at-least-32-chars', SUPER_ADMIN_OPENID: 'openid-super' },
    outboundService: async incoming => {
      const url = new URL(incoming.url);
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(url.pathname, '/sns/jscode2session');
      assert.equal(url.searchParams.get('appid'), 'test-app');
      const code = url.searchParams.get('js_code');
      return Response.json(code === 'invalid' ? { errcode: 40029 } : { openid: 'openid-' + code });
    }
  };
  runtime = new Miniflare(convertV4MiniflareOptions(options));
  db = await runtime.getD1Database('DB');
  for (const name of (await readdir('../migrations')).filter(n => n.endsWith('.sql')).sort()) {
    await migrate(await readFile('../migrations/' + name, 'utf8'));
  }
});
after(async () => { if (runtime) await runtime.dispose(); });

test('production disables unauthenticated test writes; malformed login cannot forge identity', async () => {
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/test', 'POST', { content: 'should not write' })).status, 404);
  assert.equal((await request('/auth/login', 'POST', { openid: 'openid-super' })).status, 400);
  assert.equal((await request('/auth/login', 'POST', { code: 'invalid', openid: 'openid-super' })).status, 400);
  assert.equal((await request('/organizations')).status, 401);
});

test('owner can create tenants, unbound users can login but cannot manage tenants', async () => {
  const owner = await signIn('super');
  superToken = owner.token;
  assert.equal(owner.role, 'SUPER_ADMIN');
  const a = await request('/organizations', 'POST', { name: '机构 A' }, superToken);
  const b = await request('/organizations', 'POST', { name: '机构 B' }, superToken);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  orgA = a.data.organization.id;
  orgB = b.data.organization.id;
  const pending = await signIn('pending');
  assert.equal(pending.role, null);
  assert.equal(pending.needs_binding, true);
  assert.equal((await request('/organizations', 'GET', undefined, pending.token)).status, 403);
  assert.equal((await request('/invites', 'POST', { organization_id: orgA }, pending.token)).status, 403);
  assert.equal((await request('/admins', 'GET', undefined, pending.token)).status, 403);
});

test('one invite binds exactly one administrator even with concurrent redemption', async () => {
  const code = await invite(orgA);
  const a = await signIn('member-a');
  const b = await signIn('member-b');
  const results = await Promise.all([
    request('/invites/redeem', 'POST', { code }, a.token),
    request('/invites/redeem', 'POST', { code }, b.token)
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? a : b;
  memberToken = winner.token;
  memberId = winner.user.id;
  assert.equal((await request('/me', 'GET', undefined, memberToken)).data.organization.id, orgA);
  assert.equal((await request('/invites/redeem', 'POST', { code }, memberToken)).status, 409);
});

test('one user cannot consume two invitations concurrently', async () => {
  const codeA = await invite(orgA);
  const codeB = await invite(orgB);
  const user = await signIn('racing-user');
  const results = await Promise.all([
    request('/invites/redeem', 'POST', { code: codeA }, user.token),
    request('/invites/redeem', 'POST', { code: codeB }, user.token)
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const redeemed = await db.prepare('SELECT COUNT(*) AS n FROM organization_invites WHERE used_by = ?1')
    .bind(user.user.id).first();
  assert.equal(redeemed.n, 1);
});

test('tenant administrator cannot list tenants or invite administrators into a different tenant', async () => {
  assert.equal((await request('/organizations', 'GET', undefined, memberToken)).status, 403);
  assert.equal((await request('/organizations/' + orgB, 'PATCH', { status: 'DISABLED' }, memberToken)).status, 403);
  assert.equal((await request('/invites', 'POST', { organization_id: orgB }, memberToken)).status, 403);
  const ownInvite = await request('/invites', 'POST', {}, memberToken);
  assert.equal(ownInvite.status, 201);
  const members = await request('/admins', 'GET', undefined, memberToken);
  assert.equal(members.status, 200);
  assert.ok(members.data.admins.some(u => u.id === memberId));
  for (const member of members.data.admins) {
    const row = await db.prepare('SELECT organization_id FROM users WHERE id = ?1').bind(member.id).first();
    assert.equal(row.organization_id, orgA);
    assert.equal(member.openid, undefined);
  }
});

test('expired invitation leaves both the account and invite unchanged', async () => {
  const code = await invite(orgA);
  const digest = createHash('sha256').update(code).digest('hex');
  await db.prepare('UPDATE organization_invites SET expires_at = 1 WHERE code_hash = ?1').bind(digest).run();
  const pending = await signIn('expired-invite');
  assert.equal((await request('/invites/redeem', 'POST', { code }, pending.token)).status, 409);
  assert.equal((await request('/me', 'GET', undefined, pending.token)).data.needs_binding, true);
  assert.equal((await db.prepare('SELECT used_by FROM organization_invites WHERE code_hash = ?1').bind(digest).first()).used_by, null);
});

test('disabling a tenant immediately denies old sessions, login and invite redemption', async () => {
  const code = await invite(orgA);
  const pending = await signIn('disabled-tenant-pending');
  assert.equal((await request('/organizations/' + orgA, 'PATCH', { status: 'DISABLED' }, superToken)).status, 200);
  const me = await request('/me', 'GET', undefined, memberToken);
  assert.equal(me.status, 403);
  assert.equal(me.data.error, 'ORGANIZATION_DISABLED');
  assert.equal((await request('/invites', 'POST', {}, memberToken)).status, 403);
  const member = await db.prepare('SELECT openid FROM users WHERE id = ?1').bind(memberId).first();
  assert.equal((await request('/auth/login', 'POST', { code: member.openid.slice(7) })).status, 403);
  assert.equal((await request('/invites/redeem', 'POST', { code }, pending.token)).status, 409);
  assert.equal((await request('/organizations/' + orgA, 'PATCH', { status: 'ACTIVE' }, superToken)).status, 200);
});

test('disabled user, expired session and logout revoke access', async () => {
  const user = await signIn('session-test');
  await db.prepare("UPDATE users SET status = 'DISABLED' WHERE id = ?1").bind(user.user.id).run();
  assert.equal((await request('/me', 'GET', undefined, user.token)).status, 403);
  await db.prepare("UPDATE users SET status = 'ACTIVE' WHERE id = ?1").bind(user.user.id).run();
  await db.prepare('UPDATE sessions SET expires_at = 1 WHERE user_id = ?1').bind(user.user.id).run();
  assert.equal((await request('/me', 'GET', undefined, user.token)).status, 401);
  const fresh = await signIn('session-test');
  assert.equal((await request('/auth/logout', 'POST', {}, fresh.token)).status, 200);
  assert.equal((await request('/me', 'GET', undefined, fresh.token)).status, 401);
});

test('core schema enforces tenant foreign keys, integer balances and append-only records', async () => {
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO students (id, organization_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
    .bind('student-a', orgA, '学员', now).run();
  await assert.rejects(db.prepare(`INSERT INTO lesson_packages
    (id, organization_id, student_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
    .bind('foreign-package', orgB, 'student-a', '包', now).run());
  await assert.rejects(db.prepare(`INSERT INTO lesson_packages
    (id, organization_id, student_id, name, gift_balance, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, -1, ?5, ?5)`)
    .bind('negative-package', orgA, 'student-a', '包', now).run());
  await assert.rejects(db.prepare(`INSERT INTO lesson_packages
    (id, organization_id, student_id, name, paid_balance, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1.5, ?5, ?5)`)
    .bind('decimal-package', orgA, 'student-a', '包', now).run());
  await db.prepare(`INSERT INTO lesson_packages
    (id, organization_id, student_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
    .bind('package-a', orgA, 'student-a', '包', now).run();
  await db.prepare(`INSERT INTO lesson_records
    (id, organization_id, student_id, lesson_package_id, type, paid_change, gift_change, request_id, operator_id, created_at)
    VALUES ('record-a', ?1, 'student-a', 'package-a', 'RECHARGE', 20, 3, 'request-a', ?2, ?3)`)
    .bind(orgA, memberId, now).run();
  await assert.rejects(db.prepare("UPDATE lesson_records SET paid_change = 1 WHERE id = 'record-a'").run());
  await assert.rejects(db.prepare("DELETE FROM lesson_records WHERE id = 'record-a'").run());
});

test('rotating configured owner immediately revokes previous owner privileges', async () => {
  await runtime.setOptions(convertV4MiniflareOptions({ ...options,
    bindings: { ...options.bindings, SUPER_ADMIN_OPENID: 'openid-new-owner' } }));
  assert.equal((await request('/organizations', 'GET', undefined, superToken)).status, 403);
  const old = await signIn('super');
  assert.equal(old.role, null);
  const newOwner = await signIn('new-owner');
  assert.equal(newOwner.role, 'SUPER_ADMIN');
});
