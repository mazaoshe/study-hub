// Restore the production backup into an ephemeral local D1 and test the exact
// cutover SQL, including re-login with the same identity. Never writes remotely.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const dir = resolve(process.argv[2] || '../backups/cutover-20261002');
const evidence = JSON.parse(await readFile(dir + '/import.verification.json', 'utf8'));
const plan = JSON.parse(await readFile(dir + '/final-trial/plan.json', 'utf8'));
const backup = JSON.parse(await readFile(dir + '/d1-before.statements.json', 'utf8'));
const statements = JSON.parse(await readFile(dir + '/import.statements.json', 'utf8'));
let loginOpenid;
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-09-30', d1Databases: ['DB'], bindings: { APP_ENV: 'production', WECHAT_APP_ID: 'local-test',
    WECHAT_APP_SECRET: 'local-test', SESSION_SECRET: 'local-cutover-test-secret-at-least-32-characters', SUPER_ADMIN_OPENID: 'local-test-owner' },
  outboundService: async () => Response.json({ openid: loginOpenid }) }));
try {
  const db = await runtime.getD1Database('DB');
  for (const sql of backup) {
    if (/^\s*(?:PRAGMA|BEGIN|COMMIT)/i.test(sql)) continue;
    await db.prepare(sql).run();
  }
  for (const migration of ['0004_legacy_import.sql', '0005_admin_transfers.sql']) {
    let sql = '', trigger = false;
    for (const line of (await readFile('../migrations/' + migration, 'utf8')).split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      sql += line + '\n';
      if (/^CREATE TRIGGER/i.test(line)) trigger = true;
      if (line.trim().endsWith(';') && (!trigger || /^END;/.test(line))) {
        await db.prepare(sql).run(); sql = ''; trigger = false;
      }
    }
  }
  const oldUser = await db.prepare('SELECT * FROM users WHERE id=?').bind(evidence.old_admin_id).first();
  loginOpenid = oldUser.openid;
  async function login() {
    const r = await runtime.dispatchFetch('https://local.test/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'test-login' }) });
    assert.equal(r.status, 200); return r.json();
  }
  const previous = await login();
  assert.equal(previous.user.id, evidence.old_admin_id);
  const recordBefore = (await db.prepare('SELECT * FROM lesson_records ORDER BY id').all()).results;
  const packageBefore = (await db.prepare('SELECT * FROM lesson_packages ORDER BY id').all()).results;
  // D1 batch executes the complete script in a single transaction in this local proof.
  await db.batch(statements.map(sql => db.prepare(sql)));
  const stale = await runtime.dispatchFetch('https://local.test/me', { headers: { Authorization: 'Bearer ' + previous.token } });
  assert.equal(stale.status, 401);
  const next = await login();
  assert.equal(next.user.id, evidence.new_admin_id);
  assert.equal(next.role, 'ORG_ADMIN');
  assert.equal(next.organization.id, evidence.target_org_id);
  assert.equal(next.organization.name, plan.target_name);
  assert.deepEqual((await db.prepare('SELECT * FROM lesson_records ORDER BY id').all()).results, recordBefore);
  for (const p of packageBefore) assert.deepEqual(await db.prepare('SELECT * FROM lesson_packages WHERE id=?').bind(p.id).first(), p);
  const packages = (await db.prepare('SELECT * FROM lesson_packages WHERE organization_id=?').bind(plan.target_org).all()).results;
  assert.equal(packages.length, plan.expected.length);
  for (const p of packages) {
    const expected = plan.expected.find(x => x.package_id === p.id);
    assert.equal(p.paid_balance, expected.paid_balance); assert.equal(p.gift_balance, expected.gift_balance);
  }
  const history = (await db.prepare('SELECT * FROM legacy_history WHERE organization_id=?').bind(plan.target_org).all()).results;
  assert.equal(history.length, plan.history.length);
  const byId = new Map(history.map(r => [r.id, r]));
  for (const expected of plan.history) assert.deepEqual(byId.get(expected.id), expected);
  const historyResponse = await runtime.dispatchFetch('https://local.test/legacy-records', { headers: { Authorization: 'Bearer ' + next.token } });
  assert.equal(historyResponse.status, 200); assert.equal((await historyResponse.json()).items.length, 20);
  const check = { environment: 'ephemeral local D1 restored from pre-cutover backup', remote_writes: false,
    exact_cutover_sql_verified: true, package_count: packages.length, history_count: history.length,
    stale_session_rejected: true, same_wechat_login_enters_new_organization: true,
    old_ledger_unchanged: true, old_packages_unchanged: true, history_api_access_verified: true };
  await writeFile(dir + '/d1-cutover-verification.json', JSON.stringify(check, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(check, null, 2));
} finally { await runtime.dispose(); }
