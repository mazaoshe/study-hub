// Local, ephemeral Workers/D1 verification only. Never connects to the deployed application.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const [planPath, reportPath] = process.argv.slice(2);
if (!planPath || !reportPath) throw new Error('Usage: node scripts/verify-studyhub-trial.mjs <plan.json> <report.json>');
const plan = JSON.parse(await readFile(resolve(planPath), 'utf8'));
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-09-30', d1Databases: ['DB'], bindings: { APP_ENV: 'production', WECHAT_APP_ID: 'local-test',
    WECHAT_APP_SECRET: 'local-test', SESSION_SECRET: 'local-trial-session-key-at-least-32-characters', SUPER_ADMIN_OPENID: 'trial-owner' },
  outboundService: async request => Response.json({ openid: new URL(request.url).searchParams.get('js_code') }) }));
try {
  const db = await runtime.getD1Database('DB');
  for (const name of (await readdir('../migrations')).filter(n => n.endsWith('.sql')).sort()) {
    let sql = '', trigger = false;
    for (const line of (await readFile('../migrations/' + name, 'utf8')).split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      sql += line + '\n';
      if (/^CREATE TRIGGER/i.test(line)) trigger = true;
      if (line.trim().endsWith(';') && (!trigger || /^END;/.test(line))) {
        await db.prepare(sql).run(); sql = ''; trigger = false;
      }
    }
    assert.equal(sql.trim(), '');
  }
  async function api(path, token, body) {
    const result = await runtime.dispatchFetch('https://local.test' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(result.ok, true, `${path}: ${result.status}`);
    return result.json();
  }
  const owner = (await api('/auth/login', null, { code: 'trial-owner' })).token;
  const existing = (await api('/organizations', owner, { name: 'Existing organization fixture' })).organization;
  const existingMember = (await api('/auth/login', null, { code: 'existing-member' })).token;
  const existingInvite = await api('/invites', owner, { organization_id: existing.id });
  await api('/invites/redeem', existingMember, { code: existingInvite.code });
  const oldCourse = (await api('/courses', existingMember, { name: 'Existing course' })).item;
  const oldStudent = (await api('/students', existingMember, { name: 'Existing student' })).item;
  const oldPackage = (await api('/students/' + oldStudent.id + '/packages', existingMember, { course_ids: [oldCourse.id] })).package;
  await api('/packages/' + oldPackage.id + '/recharge', existingMember, { request_id: 'existing', paid_hours: 10, gift_hours: 0 });
  const original = await api('/packages/' + oldPackage.id, existingMember);
  for (let offset = 0; offset < plan.statements.length; offset += 100) {
    await db.batch(plan.statements.slice(offset, offset + 100).map(s => db.prepare(s.sql).bind(...s.params)));
  }
  const actual = (await db.prepare('SELECT id, student_id, status, paid_balance, gift_balance FROM lesson_packages WHERE organization_id=?').bind(plan.target_org).all()).results;
  assert.equal(actual.length, plan.expected.length);
  const byId = new Map(actual.map(p => [p.id, p]));
  for (const expected of plan.expected) assert.deepEqual(byId.get(expected.package_id), { id: expected.package_id,
    student_id: expected.student_id, status: expected.status, paid_balance: expected.paid_balance, gift_balance: expected.gift_balance });
  const history = (await db.prepare('SELECT * FROM legacy_history WHERE organization_id=?').bind(plan.target_org).all()).results;
  assert.equal(history.length, plan.history.length);
  const byHistoryId = new Map(history.map(r => [r.id, r]));
  for (const expected of plan.history) assert.deepEqual(byHistoryId.get(expected.id), expected);
  assert.deepEqual(await api('/packages/' + oldPackage.id, existingMember), original);
  assert.equal((await api('/legacy-records', existingMember)).items.length, 0);

  const member = (await api('/auth/login', null, { code: 'import-member' })).token;
  const invite = await api('/invites', owner, { organization_id: plan.target_org });
  await api('/invites/redeem', member, { code: invite.code });
  const page = await api('/legacy-records', member);
  assert.equal(page.items.length, Math.min(20, plan.history.length));
  assert.equal(page.has_more, plan.history.length > 20);
  const expected = plan.expected.find(p => p.status === 'ACTIVE');
  assert.ok(expected);
  const pack = (await api('/packages/' + expected.package_id, member)).package;
  assert.equal(pack.legacy_opening.paid_hours, expected.paid_balance);
  const consumption = await api('/packages/' + pack.id + '/consume', member, { request_id: 'trial-consume', course_id: pack.courses[0].id, hours: 1 });
  assert.equal((await api('/packages/' + pack.id, member)).package.paid_balance, expected.paid_balance - 1);
  await api('/lesson-records/' + consumption.record.id + '/reverse', member, { request_id: 'trial-reverse', remark: 'Local trial only' });
  assert.equal((await api('/packages/' + pack.id, member)).package.paid_balance, expected.paid_balance);
  const report = { environment: 'ephemeral local Workers/D1', remote_writes: false, organization: plan.target_name,
    packages_verified: actual.length, history_rows_verified: history.length, existing_organization_unchanged: true,
    tenant_isolation_verified: true, admin_invitation_verified: true, consume_and_reverse_verified: true,
    history_api_verified: true, opening_visible_in_package_api: true };
  await writeFile(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.dispose();
}
