import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import vm from 'node:vm';
let runtime, db, owner, token, other, student, course, second, pack;
async function req(path, method = 'GET', data, auth = token) {
  const response = await runtime.dispatchFetch('https://test.local' + path, { method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, data: response.headers.get('content-type')?.includes('csv') ? await response.text() : await response.json() };
}
async function ok(path, method, data, auth) {
  const result = await req(path, method, data, auth);
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.data;
}
async function operation(action, data, id = pack, key = crypto.randomUUID()) {
  return req(action === 'reverse' ? '/lesson-records/' + id + '/reverse' : '/packages/' + id + '/' + action,
    'POST', { request_id: key, ...data });
}
async function balances(id = pack) { return (await ok('/packages/' + id)).package; }
before(async () => {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-30', d1Databases: ['DB'], bindings: { APP_ENV: 'production', WECHAT_APP_ID: 'test',
      WECHAT_APP_SECRET: 'test', SESSION_SECRET: 'test-only-secret-for-ledger-at-least-32-chars', SUPER_ADMIN_OPENID: 'super' },
    outboundService: async request => Response.json({ openid: new URL(request.url).searchParams.get('js_code') }) }));
  db = await runtime.getD1Database('DB');
  for (const file of (await readdir('../migrations')).filter(n => n.endsWith('.sql')).sort()) {
    let statement = '', trigger = false;
    for (const line of (await readFile('../migrations/' + file, 'utf8')).split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      statement += line + '\n';
      if (/^CREATE TRIGGER/i.test(line)) trigger = true;
      if (line.trim().endsWith(';') && (!trigger || /^END;/.test(line))) {
        await db.prepare(statement).run(); statement = ''; trigger = false;
      }
    }
    assert.equal(statement.trim(), '');
  }
  owner = (await ok('/auth/login', 'POST', { code: 'super' }, null)).token;
  for (const code of ['member', 'other']) {
    const org = (await ok('/organizations', 'POST', { name: code }, owner)).organization.id;
    const invite = (await ok('/invites', 'POST', { organization_id: org }, owner)).code;
    const session = (await ok('/auth/login', 'POST', { code }, null)).token;
    await ok('/invites/redeem', 'POST', { code: invite }, session);
    if (code === 'member') token = session; else other = session;
  }
  course = (await ok('/courses', 'POST', { name: '英语' })).item.id;
  second = (await ok('/courses', 'POST', { name: '阅读' })).item.id;
  student = (await ok('/students', 'POST', { name: '=学员', phone: '+123', remark: '多行\n备注,"测试"' })).item.id;
  pack = (await ok('/students/' + student + '/packages', 'POST', { name: '共享课时包', course_ids: [course, second] })).package.id;
});
after(async () => { if (runtime) await runtime.dispose(); });

test('student sorting uses pinyin across pages, supports balances and keeps archive time independent of edits', async () => {
  const ids = [];
  for (const surname of ['张', '王', '李', '陈']) {
    for (let i = 1; i <= 6; i++) ids.push((await ok('/students', 'POST', { name: surname + i + '-排序验证' })).item.id);
  }
  const query = '/students?search=' + encodeURIComponent('排序验证');
  const first = await ok(query + '&sort=name'), next = await ok(query + '&sort=name&page=2');
  const names = first.items.concat(next.items).map(item => item.name);
  assert.equal(first.items.length, 20); assert.equal(next.items.length, 4);
  assert.deepEqual(names, ['陈', '李', '王', '张'].flatMap(surname => Array.from({ length: 6 }, (_, i) => surname + (i + 1) + '-排序验证')));
  assert.equal(new Set(first.items.concat(next.items).map(item => item.id)).size, 24);
  const defaultOrder = await ok(query);
  assert.deepEqual(defaultOrder.items.map(item => item.id), first.items.map(item => item.id));
  const newest = ids[0];
  await db.prepare('UPDATE students SET created_at = ? WHERE id = ?').bind('2099-01-01T00:00:00.000Z', newest).run();
  assert.equal((await ok(query + '&sort=newest')).items[0].id, newest);
  const negative = (await ok('/students/' + ids[1] + '/packages', 'POST', { course_ids: [course] })).package.id;
  await operation('consume', { hours: 2, course_id: course }, negative);
  const balance = await ok(query + '&sort=balance');
  assert.equal(balance.items[0].id, ids[1]); assert.equal(balance.items[0].total_balance, -2);
  assert.equal((await req(query + '&sort=unknown')).status, 400);
  assert.equal((await ok(query + '&sort=name', 'GET', undefined, other)).total, 0);

  const archive = (await ok('/students/' + ids[0], 'PATCH', { status: 'ARCHIVED' })).item;
  assert.ok(archive.archived_at);
  await db.prepare('UPDATE students SET archived_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', ids[0]).run();
  const edited = (await ok('/students/' + ids[0], 'PATCH', { remark: '归档后补备注' })).item;
  assert.equal(edited.archived_at, '2020-01-01T00:00:00.000Z');
  await ok('/students/' + ids[1], 'PATCH', { status: 'ARCHIVED' });
  // Model an imported archive whose original archive time is unknown.
  await db.prepare("UPDATE students SET status = 'ARCHIVED' WHERE id = ?").bind(ids[2]).run();
  const archives = await ok(query + '&status=ARCHIVED');
  assert.deepEqual(archives.items.map(item => item.id), [ids[1], ids[0], ids[2]]);
  assert.equal(archives.items[2].archived_at, null);
  assert.equal((await ok('/students/' + ids[0], 'PATCH', { status: 'ACTIVE' })).item.archived_at, null);
  const archivedAgain = (await ok('/students/' + ids[0], 'PATCH', { status: 'ARCHIVED' })).item;
  assert.ok(archivedAgain.archived_at > '2020-01-01T00:00:00.000Z');
});

test('shared courses consume gift first, paid can be negative, reversal preserves audit', async () => {
  assert.equal((await operation('recharge', { paid_hours: 20, gift_hours: 3 })).status, 200);
  for (const [id, hours] of [[course, 1], [second, 2]]) assert.equal((await operation('consume', { course_id: id, hours })).status, 200);
  let balance = await balances(); assert.equal(balance.paid_balance, 20); assert.equal(balance.gift_balance, 0);
  const consume = await operation('consume', { course_id: course, hours: 21 });
  assert.equal(consume.status, 200);
  assert.equal((await balances()).paid_balance, -1);
  assert.equal((await operation('reverse', { remark: '录错' }, consume.data.record.id)).status, 200);
  assert.equal((await balances()).paid_balance, 20);
  assert.equal((await operation('reverse', {}, consume.data.record.id)).status, 409);
  const list = await ok('/lesson-records?package_id=' + pack);
  assert.equal(list.items.find(r => r.id === consume.data.record.id).reversed, 1);
});

test('simultaneous consumption allocates gift exactly once and duplicate intent is idempotent', async () => {
  await operation('recharge', { paid_hours: 0, gift_hours: 3 });
  const key = crypto.randomUUID();
  const results = await Promise.all([
    operation('consume', { course_id: course, hours: 2 }, pack, key),
    operation('consume', { course_id: course, hours: 2 }, pack, key),
    operation('consume', { course_id: second, hours: 2 })
  ]);
  results.forEach(result => assert.equal(result.status, 200, JSON.stringify(result)));
  assert.equal(results[0].data.record.id, results[1].data.record.id);
  assert.equal((await balances()).gift_balance, 0);
  assert.equal((await balances()).paid_balance, 19);
  assert.equal((await operation('consume', { course_id: course, hours: 3 }, pack, key)).status, 409);
});

test('recharge reversal rejects already used gift atomically; simultaneous reversal only happens once', async () => {
  const recharge = await operation('recharge', { paid_hours: 5, gift_hours: 2 });
  await operation('consume', { course_id: course, hours: 2 });
  const before = await balances();
  const result = await operation('reverse', {}, recharge.data.record.id);
  assert.equal(result.status, 409); assert.equal(result.data.error, 'GIFT_BALANCE_INSUFFICIENT');
  assert.equal((await balances()).paid_balance, before.paid_balance);
  const consume = await operation('consume', { course_id: course, hours: 1 });
  const racing = await Promise.all([operation('reverse', {}, consume.data.record.id), operation('reverse', {}, consume.data.record.id)]);
  assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
  assert.equal((await balances()).paid_balance, before.paid_balance);
});

test('tenant isolation includes details, writes, course bindings, records and CSV', async () => {
  for (const path of ['/students/' + student, '/courses/' + course, '/packages/' + pack]) {
    assert.equal((await req(path, 'GET', undefined, other)).status, 404);
    assert.equal((await req(path, 'PATCH', { name: 'hacked' }, other)).status, 404);
  }
  assert.equal((await req('/packages/' + pack + '/recharge', 'POST', { request_id: 'hack', paid_hours: 1, gift_hours: 0 }, other)).status, 409);
  assert.equal((await req('/lesson-records?package_id=' + pack, 'GET', undefined, other)).data.items.length, 0);
  const csv = await req('/exports/records', 'GET', undefined, other);
  assert.equal(csv.status, 200); assert.ok(!csv.data.includes('共享课时包'));
  assert.equal((await req('/students', 'GET', undefined, owner)).status, 403);
  const foreignCourse = (await ok('/courses', 'POST', { name: '外部课程' }, other)).item.id;
  assert.equal((await req('/packages/' + pack, 'PATCH', { name: '错误名称', course_ids: [foreignCourse] })).status, 409);
  const unchanged = await balances(); assert.equal(unchanged.name, '共享课时包'); assert.equal(unchanged.courses.length, 2);
});

test('archived records remain visible, new operations stop, reversal and restore still work', async () => {
  const consume = await operation('consume', { course_id: course, hours: 1 });
  await ok('/courses/' + course, 'PATCH', { status: 'ARCHIVED' });
  assert.equal((await operation('consume', { course_id: course, hours: 1 })).status, 409);
  await ok('/students/' + student, 'PATCH', { status: 'ARCHIVED' });
  assert.equal((await operation('recharge', { paid_hours: 1, gift_hours: 0 })).status, 409);
  await ok('/packages/' + pack, 'PATCH', { status: 'ARCHIVED' });
  assert.equal((await operation('reverse', {}, consume.data.record.id)).status, 200);
  await ok('/students/' + student, 'PATCH', { status: 'ACTIVE' });
  await ok('/courses/' + course, 'PATCH', { status: 'ACTIVE' });
  await ok('/packages/' + pack, 'PATCH', { status: 'ACTIVE' });
  assert.equal((await operation('consume', { course_id: course, hours: 1 })).status, 200);
});

test('invalid hours and balance overflow never leave a partial ledger entry', async () => {
  for (const hours of [0, -1, 1.5, '2']) assert.equal((await operation('consume', { course_id: course, hours })).status, 400);
  const before = await balances();
  assert.equal((await operation('recharge', { paid_hours: Number.MAX_SAFE_INTEGER, gift_hours: 0 })).status, 409);
  assert.equal((await balances()).paid_balance, before.paid_balance);
  assert.equal((await req('/students/' + student + '/packages', 'POST', { name: '非法课时包', course_ids: ['absent'] })).status, 409);
  assert.equal((await ok('/students/' + student + '/packages')).packages.length, 1);
});

test('CSV exports include archived data, course relationships and prevent formula injection', async () => {
  const students = await ok('/exports/students');
  assert.ok(students.includes("'=")); assert.ok(students.includes("'+123")); assert.ok(students.includes('""测试""'));
  const packages = await ok('/exports/packages'); assert.ok(packages.includes('英语')); assert.ok(packages.includes('阅读'));
  const records = await ok('/exports/records'); assert.ok(records.includes('REVERSAL')); assert.ok(records.includes('CONSUME')); assert.ok(records.includes('RECHARGE'));
});

test('mini-program retry after lost response and page reload reuses intent instead of charging twice', async () => {
  const source = await readFile('../miniprogram/pages/package/index.js', 'utf8');
  const ledgerSource = await readFile('../miniprogram/services/ledger.js', 'utf8');
  const storage = new Map();
  let loseResponse = true;
  const createPage = () => {
    let page;
    const wx = {
      getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key)
    };
    const request = async (path, method, body) => {
      const response = await ok(path, method, body);
      if (loseResponse) { loseResponse = false; throw new Error('connection lost after commit'); }
      return response;
    };
    const ledgerModule = { exports: {} };
    vm.runInNewContext(ledgerSource, { module: ledgerModule, wx, require: () => ({ request }) });
    vm.runInNewContext(source, { Page: definition => { page = definition; }, wx,
      require: name => name.endsWith('/ledger') ? ledgerModule.exports : name.endsWith('/api') ? { request } : {} });
    page.id = pack; page.userId = 'test-member';
    return page;
  };
  const before = await balances();
  const payload = { paid_hours: 2, gift_hours: 0, remark: 'lost response' };
  await assert.rejects(createPage().send('recharge', payload));
  assert.equal((await balances()).paid_balance, before.paid_balance + 2);
  const reloaded = createPage();
  await reloaded.send('recharge', payload);
  assert.equal((await balances()).paid_balance, before.paid_balance + 2);
  assert.equal(storage.size, 0);
  await reloaded.send('recharge', payload);
  assert.equal((await balances()).paid_balance, before.paid_balance + 4);
});

test('dashboard follows student total balances, excludes archives, and isolates tenants', async () => {
  assert.equal((await ok('/dashboard')).count, 0);
  async function setup(name, paid, gift, auth = token) {
    const courseId = auth === token ? course : (await ok('/courses', 'POST', { name: '其他机构课程' }, auth)).item.id;
    const id = (await ok('/students', 'POST', { name, phone: '12345' }, auth)).item.id;
    const packageId = (await ok('/students/' + id + '/packages', 'POST', { name: '余额测试', course_ids: [courseId] }, auth)).package.id;
    if (paid + gift > 0) await ok('/packages/' + packageId + '/recharge', 'POST', { request_id: crypto.randomUUID(), paid_hours: paid, gift_hours: gift }, auth);
    return { id, packageId };
  }
  const low = await setup('赠送合计3', 1, 2);
  const zero = await setup('余额0', 0, 0);
  const debt = await setup('透支2', 0, 0);
  await operation('consume', { course_id: course, hours: 2 }, debt.packageId);
  const high = await setup('余额4', 4, 0);
  const multi = await setup('两个包合计4', 1, 0);
  const extra = (await ok('/students/' + multi.id + '/packages', 'POST', { name: '额外3', course_ids: [second] })).package.id;
  await operation('recharge', { paid_hours: 3, gift_hours: 0 }, extra);
  await ok('/students', 'POST', { name: '尚无课时包' });
  const archivedStudent = await setup('归档学员', 0, 0);
  await ok('/students/' + archivedStudent.id, 'PATCH', { status: 'ARCHIVED' });
  const archivedPackage = await setup('归档包学员', 0, 0);
  await ok('/packages/' + archivedPackage.packageId, 'PATCH', { status: 'ARCHIVED' });
  const foreign = await setup('其他机构低余额', 0, 0, other);
  const own = await ok('/dashboard');
  assert.equal(own.count, 3);
  assert.deepEqual(own.students.map(s => s.id), [debt.id, zero.id, low.id]);
  assert.deepEqual(own.students.map(s => s.total_balance), [-2, 0, 3]);
  assert.equal(own.students[2].gift_balance, 2);
  assert.ok(!own.students.some(s => [high.id, multi.id, foreign.id].includes(s.id)));
  const theirs = await ok('/dashboard', 'GET', undefined, other);
  assert.deepEqual(theirs.students.map(s => s.id), [foreign.id]);
  assert.equal((await req('/dashboard', 'GET', undefined, owner)).status, 403);
  assert.equal((await req('/dashboard', 'GET', undefined, null)).status, 401);
  await ok('/packages/' + extra, 'PATCH', { status: 'ARCHIVED' });
  const refreshed = await ok('/dashboard');
  assert.equal(refreshed.count, 4);
  assert.equal(refreshed.students.find(s => s.id === multi.id).total_balance, 1);
});

test('dashboard pagination counts students once and does not skip or duplicate alerts', async () => {
  for (let i = 0; i < 21; i++) {
    const id = (await ok('/students', 'POST', { name: '分页' + i })).item.id;
    await ok('/students/' + id + '/packages', 'POST', { name: '空课时包', course_ids: [course] });
  }
  const first = await ok('/dashboard?page=1'), next = await ok('/dashboard?page=2');
  assert.equal(first.count, 25); assert.equal(next.count, 25);
  assert.equal(first.students.length, 20); assert.equal(next.students.length, 5);
  assert.equal(first.has_more, true); assert.equal(next.has_more, false);
  assert.equal(new Set(first.students.concat(next.students).map(s => s.id)).size, 25);
  assert.equal((await req('/dashboard?page=-1')).status, 400);
});

test('package names are generated from selected courses while legacy custom names still work', async () => {
  const id = (await ok('/students', 'POST', { name: '自动命名学员' })).item.id;
  const single = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [course] })).package;
  assert.equal(single.name, '英语课时包');
  const shared = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [second, course] })).package;
  assert.equal(shared.name, '阅读／英语课时包');
  assert.deepEqual(new Set(shared.courses.map(c => c.id)), new Set([course, second]));
  const blank = (await ok('/students/' + id + '/packages', 'POST', { name: '  ', course_ids: [course] })).package;
  assert.equal(blank.name, '英语课时包');
  const custom = (await ok('/students/' + id + '/packages', 'POST', { name: '旧客户端自定义名称', course_ids: [course] })).package;
  assert.equal(custom.name, '旧客户端自定义名称');
  const long = (await ok('/courses', 'POST', { name: '长'.repeat(80) })).item.id;
  const shortened = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [long] })).package;
  assert.ok(shortened.name.length <= 80); assert.ok(shortened.name.endsWith('课时包'));
  const before = (await ok('/students/' + id + '/packages')).packages.length;
  assert.equal((await req('/students/' + id + '/packages', 'POST', { course_ids: ['foreign-or-missing'] })).status, 409);
  assert.equal((await req('/students/' + id + '/packages', 'POST', { course_ids: [course] }, other)).status, 409);
  assert.equal((await ok('/students/' + id + '/packages')).packages.length, before);
});

test('home search finds all active students by name or phone regardless of balances, with tenant isolation and pagination', async () => {
  const high = await ok('/dashboard?search=' + encodeURIComponent('余额4'));
  assert.equal(high.count, 1); assert.equal(high.students[0].total_balance, 4);
  const id = (await ok('/students', 'POST', { name: '王小明搜索', phone: '13800138000' })).item.id;
  const archived = (await ok('/students', 'POST', { name: '王小明归档', phone: '13800138000' })).item.id;
  await ok('/students/' + archived, 'PATCH', { status: 'ARCHIVED' });
  await ok('/students', 'POST', { name: '王小明搜索', phone: '13800138000' }, other);
  for (const keyword of ['王小明', '1380013']) {
    const found = await ok('/dashboard?search=' + encodeURIComponent(keyword));
    assert.equal(found.count, 1); assert.equal(found.students[0].id, id);
    assert.equal(found.students[0].package_count, 0); assert.equal(found.students[0].total_balance, 0);
  }
  const theirs = await ok('/dashboard?search=' + encodeURIComponent('王小明'), 'GET', undefined, other);
  assert.equal(theirs.count, 1); assert.notEqual(theirs.students[0].id, id);
  const first = await ok('/dashboard?search=' + encodeURIComponent('分页') + '&page=1');
  const next = await ok('/dashboard?search=' + encodeURIComponent('分页') + '&page=2');
  assert.equal(first.count, 21); assert.equal(first.students.length, 20); assert.equal(next.students.length, 1);
  assert.equal(new Set(first.students.concat(next.students).map(s => s.id)).size, 21);
  await ok('/students', 'POST', { name: '%_标记' });
  assert.equal((await ok('/dashboard?search=%25_')).count, 1);
  assert.equal((await ok('/dashboard?search=does-not-exist')).count, 0);
  assert.equal((await req('/dashboard?search=' + 'x'.repeat(81))).status, 400);
  const alerts = await ok('/dashboard');
  assert.equal((await ok('/dashboard?search=%20%20')).count, alerts.count);
  assert.ok(!alerts.students.some(s => s.id === id));
});

test('legacy opening, history queries, exports and ongoing ledger preserve balances and tenant boundaries', async () => {
  const identity = await ok('/me');
  const org = identity.organization.id;
  const id = (await ok('/students', 'POST', { name: '迁移学员' })).item.id;
  const packageId = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [course] })).package.id;
  await db.prepare(`INSERT INTO legacy_imports VALUES ('legacy-import', ?, 'studyhub-test', 1, 'snapshot', '2026-10-02T05:00:00Z')`).bind(org).run();
  await db.prepare(`INSERT INTO legacy_openings VALUES (?, ?, ?, 'legacy-import', 1, 30, 10, 0, '2026-10-02T05:00:00Z', '旧构成未知')`).bind(packageId, org, id).run();
  for (let i = 0; i < 22; i++) {
    await db.prepare(`INSERT INTO legacy_history VALUES (?, ?, ?, ?, 'legacy-import', ?, 'add', ?, ?, NULL, '2020-01-01T08:30:00', NULL, NULL)`)
      .bind('legacy-' + i, org, id, packageId, i, i === 0 ? 0 : 2, '=旧课程').run();
  }
  let pack = await balances(packageId);
  assert.equal(pack.paid_balance, 10); assert.equal(pack.legacy_opening.paid_hours, 10);
  assert.equal((await ok('/lesson-records?package_id=' + packageId)).items.length, 0);
  const first = await ok('/legacy-records?package_id=' + packageId);
  const next = await ok('/legacy-records?package_id=' + packageId + '&page=2');
  assert.equal(first.items.length, 20); assert.equal(first.has_more, true);
  assert.equal(next.items.length, 2); assert.equal(next.has_more, false);
  assert.equal(new Set(first.items.concat(next.items).map(r => r.id)).size, 22);
  assert.equal(next.items.find(r => r.source_record_id === 0).hours, 0);
  assert.equal(next.items[0].use_date, null);
  assert.equal((await ok('/legacy-records?student_id=' + id)).items.length, 20);
  assert.equal((await ok('/legacy-records?package_id=' + packageId, 'GET', undefined, other)).items.length, 0);
  assert.equal((await req('/legacy-records', 'GET', undefined, null)).status, 401);
  assert.equal((await req('/legacy-records', 'GET', undefined, owner)).status, 403);
  assert.equal((await req('/legacy-records?page=-1')).status, 400);
  assert.equal((await req('/lesson-records/legacy-0/reverse', 'POST', { request_id: 'legacy-reverse' })).status, 409);
  await assert.rejects(db.prepare('UPDATE legacy_openings SET paid_hours=20 WHERE lesson_package_id=?').bind(packageId).run(), /LEGACY_APPEND_ONLY/);
  await assert.rejects(db.prepare("DELETE FROM legacy_history WHERE id='legacy-0'").run(), /LEGACY_APPEND_ONLY/);
  const historyCSV = await ok('/exports/legacy-records');
  assert.ok(historyCSV.includes('迁移学员')); assert.ok(historyCSV.includes("'=旧课程"));
  const openingCSV = await ok('/exports/legacy-openings');
  assert.ok(openingCSV.includes('旧构成未知'));
  assert.ok(!(await ok('/exports/legacy-records', 'GET', undefined, other)).includes('迁移学员'));
  assert.ok(!(await ok('/exports/legacy-openings', 'GET', undefined, other)).includes('迁移学员'));
  const use = await operation('consume', { hours: 3, course_id: course }, packageId);
  assert.equal(use.status, 200); assert.equal((await balances(packageId)).paid_balance, 7);
  assert.equal((await operation('reverse', {}, use.data.record.id)).status, 200);
  assert.equal((await balances(packageId)).paid_balance, 10);
  await ok('/students/' + id, 'PATCH', { status: 'ARCHIVED' });
  assert.equal((await ok('/legacy-records?package_id=' + packageId)).items.length, 20);
  assert.equal((await operation('consume', { hours: 1, course_id: course }, packageId)).status, 409);
  const emptyId = (await ok('/students', 'POST', { name: '新业务包' })).item.id;
  const used = (await ok('/students/' + emptyId + '/packages', 'POST', { course_ids: [course] })).package.id;
  await operation('recharge', { paid_hours: 1, gift_hours: 0 }, used);
  await assert.rejects(db.prepare(`INSERT INTO legacy_openings VALUES (?, ?, ?, 'legacy-import', 2, 30, 10, 0, 'now', 'test')`).bind(used, org, emptyId).run(), /LEGACY_OPENING_REQUIRES_EMPTY_PACKAGE/);
});

test('complete catalog counts and paginates all students, searches phones and isolates archives and tenants', async () => {
  const ids = [];
  for (let i = 0; i < 22; i++) ids.push((await ok('/students', 'POST', { name: '名单核对-' + i, phone: '18888800000' })).item.id);
  await ok('/students/' + ids.at(-1), 'PATCH', { status: 'ARCHIVED' });
  await ok('/students', 'POST', { name: '名单核对-其他机构', phone: '18888800000' }, other);
  const keyword = encodeURIComponent('名单核对-');
  const first = await ok('/students?archived=1&search=' + keyword);
  const next = await ok('/students?archived=1&search=' + keyword + '&page=2');
  assert.equal(first.total, 22); assert.equal(next.total, 22);
  assert.equal(first.items.length, 20); assert.equal(next.items.length, 2);
  assert.equal(first.has_more, true); assert.equal(next.has_more, false);
  assert.deepEqual(new Set(first.items.concat(next.items).map(s => s.id)), new Set(ids));
  assert.equal((await ok('/students?search=' + keyword)).total, 21);
  assert.equal((await ok('/students?archived=1&search=188888')).total, 22);
  assert.equal((await ok('/students?archived=1&search=188888', 'GET', undefined, other)).total, 1);
  assert.equal((await ok('/students?archived=1&search=missing-student-name')).total, 0);
  assert.equal((await req('/students?page=0')).status, 400);
  const active = await ok('/students?status=ACTIVE&search=' + keyword);
  const activeNext = await ok('/students?status=ACTIVE&search=' + keyword + '&page=2');
  assert.equal(active.total, 21); assert.equal(activeNext.items.length, 1);
  assert.equal(active.has_more, true); assert.equal(activeNext.has_more, false);
  assert.ok(active.items.concat(activeNext.items).every(item => item.status === 'ACTIVE'));
  const archived = await ok('/students?status=ARCHIVED&archived=1&search=188888');
  assert.equal(archived.total, 1); assert.equal(archived.has_more, false);
  assert.deepEqual(archived.items.map(item => item.id), [ids.at(-1)]);
  assert.equal((await ok('/students?status=ARCHIVED&search=188888&page=2')).items.length, 0);
  assert.equal((await ok('/students?status=ARCHIVED&search=188888', 'GET', undefined, other)).total, 0);
  assert.equal((await ok('/students?status=ARCHIVED&search=missing-student-name')).total, 0);
  assert.equal((await req('/students?status=INVALID')).status, 400);
  await ok('/students/' + ids.at(-1), 'PATCH', { status: 'ACTIVE' });
  assert.equal((await ok('/students?status=ARCHIVED&search=' + keyword)).total, 0);
  assert.equal((await ok('/students?status=ACTIVE&search=' + keyword)).total, 22);
  await ok('/courses', 'POST', { name: '名单课程' });
  assert.equal((await ok('/courses?search=' + encodeURIComponent('名单课程'))).total, 1);
});

test('student list summarizes each active package once, preserves negative balances and excludes archived packages', async () => {
  const learner = (await ok('/students', 'POST', { name: '列表余额核对' })).item.id;
  const empty = (await ok('/students', 'POST', { name: '列表余额核对无包' })).item.id;
  const first = (await ok('/students/' + learner + '/packages', 'POST', { course_ids: [course, second] })).package.id;
  const next = (await ok('/students/' + learner + '/packages', 'POST', { course_ids: [course] })).package.id;
  const archived = (await ok('/students/' + learner + '/packages', 'POST', { course_ids: [course] })).package.id;
  await operation('recharge', { paid_hours: 4, gift_hours: 2 }, first);
  await operation('consume', { hours: 7, course_id: course }, first);
  await operation('recharge', { paid_hours: 3, gift_hours: 1 }, next);
  await operation('recharge', { paid_hours: 100, gift_hours: 20 }, archived);
  await ok('/packages/' + archived, 'PATCH', { status: 'ARCHIVED' });
  const list = await ok('/students?search=' + encodeURIComponent('列表余额核对'));
  const row = list.items.find(item => item.id === learner), noPackage = list.items.find(item => item.id === empty);
  assert.equal(list.total, 2); assert.equal(row.package_count, 2);
  assert.equal(row.paid_balance, 2); assert.equal(row.gift_balance, 1); assert.equal(row.total_balance, 3);
  assert.equal(noPackage.package_count, 0); assert.equal(noPackage.total_balance, 0);
  await operation('consume', { hours: 5, course_id: course }, next);
  assert.equal((await ok('/students?search=' + encodeURIComponent('列表余额核对'))).items.find(item => item.id === learner).total_balance, -2);
  await ok('/students/' + learner, 'PATCH', { status: 'ARCHIVED' });
  const retained = await ok('/students?archived=1&search=' + encodeURIComponent('列表余额核对'));
  assert.equal(retained.items.find(item => item.id === learner).total_balance, -2);
  assert.equal((await ok('/students?archived=1&search=' + encodeURIComponent('列表余额核对'), 'GET', undefined, other)).total, 0);
});


test('public student exports hide only import metadata and preserve stored source notes', async () => {
  const id = (await ok('/students', 'POST', { name: '备注导出核对', remark: 'StudyHub 旧学员编号 987654321\n保留业务备注' })).item.id;
  const csv = await ok('/exports/students');
  assert.ok(csv.includes('保留业务备注')); assert.ok(!csv.includes('StudyHub 旧学员编号 987654321'));
  assert.equal((await ok('/students/' + id)).item.remark, 'StudyHub 旧学员编号 987654321\n保留业务备注');
  const history = await ok('/exports/legacy-records');
  assert.ok(history.startsWith('"记录编号"')); assert.ok(!history.includes('旧记录编号'));
});

async function withdrawalStudent(name = '退学核对', specs = [{ paid: 5, gift: 2 }]) {
  const id = (await ok('/students', 'POST', { name })).item.id;
  const ids = [];
  for (const spec of specs) {
    const packageId = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [course] })).package.id;
    if (spec.paid || spec.gift) assert.equal((await operation('recharge', { paid_hours: spec.paid || 0, gift_hours: spec.gift || 0 }, packageId)).status, 200);
    if (spec.archived) await ok('/packages/' + packageId, 'PATCH', { status: 'ARCHIVED' });
    ids.push(packageId);
  }
  return { id, ids };
}
async function withdrawalPayload(id, extra = {}) {
  const preview = await ok('/students/' + id + '/withdrawal-preview');
  return { request_id: crypto.randomUUID(), expected_snapshot: preview.snapshot, refund_confirmed: true, remark: '线下退费已完成', ...extra };
}

test('withdrawal atomically clears all active and archived packages, preserves audit and seals refunded hours', async () => {
  const { id, ids } = await withdrawalStudent('多包结清', [{ paid: 5, gift: 2 }, { paid: 3, archived: true }, {}, { gift: 1 }]);
  await ok('/students/' + id, 'PATCH', { status: 'ARCHIVED' });
  const payload = await withdrawalPayload(id);
  assert.equal((await req('/students/' + id + '/withdraw', 'POST', { ...payload, refund_confirmed: false })).status, 400);
  const result = await ok('/students/' + id + '/withdraw', 'POST', payload);
  assert.equal(result.lines.length, 4);
  assert.equal(result.lines.reduce((n, row) => n + row.paid_change, 0), -8);
  assert.equal(result.lines.reduce((n, row) => n + row.gift_change, 0), -3);
  for (const packageId of ids) {
    const value = await balances(packageId);
    assert.equal(value.paid_balance, 0); assert.equal(value.gift_balance, 0); assert.equal(value.status, 'ARCHIVED'); assert.equal(value.settled, 1);
    assert.equal((await req('/packages/' + packageId, 'PATCH', { status: 'ACTIVE' })).status, 409);
    const history = await ok('/lesson-records?package_id=' + packageId);
    assert.equal(history.items.filter(row => row.type === 'WITHDRAWAL').length, 1);
    assert.ok(history.items.every(row => row.settled));
    const old = history.items.find(row => row.type === 'RECHARGE');
    if (old) { const reversal = await operation('reverse', { remark: '结清后不能冲正' }, old.id); assert.equal(reversal.status, 409); assert.equal(reversal.data.error, 'PACKAGE_SETTLED'); }
  }
  assert.equal((await ok('/students/' + id)).item.status, 'ARCHIVED');
  assert.equal((await ok('/students/' + id + '/withdraw', 'POST', payload)).withdrawal.id, result.withdrawal.id);
  assert.equal((await req('/students/' + id + '/withdraw', 'POST', { ...payload, remark: '更改操作内容' })).status, 409);
  assert.ok((await ok('/exports/records')).includes('WITHDRAWAL'));
  await assert.rejects(db.prepare('UPDATE student_withdrawals SET remark = ? WHERE id = ?').bind('changed', result.withdrawal.id).run(), /WITHDRAWAL_APPEND_ONLY/);
  await assert.rejects(db.prepare('DELETE FROM withdrawal_lines WHERE withdrawal_id = ?').bind(result.withdrawal.id).run(), /WITHDRAWAL_APPEND_ONLY/);
  await assert.rejects(db.prepare('UPDATE lesson_packages SET paid_balance = 5 WHERE id = ?').bind(ids[0]).run(), /PACKAGE_SETTLED/);
  // Restoring the student never restores refunded hours; re-enrollment uses a new package.
  await ok('/students/' + id, 'PATCH', { status: 'ACTIVE' });
  assert.equal((await operation('recharge', { paid_hours: 1, gift_hours: 0 }, ids[0])).status, 409);
  const fresh = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [course] })).package.id;
  assert.equal((await operation('recharge', { paid_hours: 2, gift_hours: 0 }, fresh)).status, 200);
  const next = await ok('/students/' + id + '/withdraw', 'POST', await withdrawalPayload(id));
  assert.equal(next.lines.length, 1); assert.equal(next.lines[0].lesson_package_id, fresh);
});

test('withdrawal rejects stale previews including equal-balance activity and status ABA, without partial writes', async () => {
  const { id, ids } = await withdrawalStudent('并发余额核对', [{ paid: 5 }]);
  let payload = await withdrawalPayload(id);
  await operation('recharge', { paid_hours: 1, gift_hours: 0 }, ids[0]);
  await operation('consume', { hours: 1, course_id: course }, ids[0]);
  assert.equal((await balances(ids[0])).paid_balance, 5);
  let result = await req('/students/' + id + '/withdraw', 'POST', payload);
  assert.equal(result.data.error, 'WITHDRAWAL_BALANCE_CHANGED');
  payload = await withdrawalPayload(id);
  await ok('/students/' + id, 'PATCH', { status: 'ARCHIVED' }); await ok('/students/' + id, 'PATCH', { status: 'ACTIVE' });
  result = await req('/students/' + id + '/withdraw', 'POST', payload);
  assert.equal(result.data.error, 'WITHDRAWAL_BALANCE_CHANGED');
  assert.equal((await balances(ids[0])).paid_balance, 5);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM student_withdrawals WHERE student_id = ?').bind(id).first()).n, 0);
  // Negative balances block the whole settlement, including positive sibling packages.
  await operation('consume', { hours: 6, course_id: course }, ids[0]);
  const additional = (await ok('/students/' + id + '/packages', 'POST', { course_ids: [course] })).package.id;
  await operation('recharge', { paid_hours: 10, gift_hours: 2 }, additional);
  result = await req('/students/' + id + '/withdraw', 'POST', await withdrawalPayload(id));
  assert.equal(result.data.error, 'WITHDRAWAL_OVERDRAFT');
  assert.equal((await balances(additional)).paid_balance, 10); assert.equal((await balances(additional)).status, 'ACTIVE');
});

test('withdrawal retries and concurrent submissions settle exactly once and isolate tenants', async () => {
  const { id, ids } = await withdrawalStudent('重复结清核对');
  const payload = await withdrawalPayload(id);
  assert.equal((await req('/students/' + id + '/withdrawal-preview', 'GET', undefined, other)).status, 404);
  assert.equal((await req('/students/' + id + '/withdraw', 'POST', payload, other)).status, 409);
  assert.equal((await balances(ids[0])).paid_balance, 5);
  const repeated = await Promise.all([req('/students/' + id + '/withdraw', 'POST', payload), req('/students/' + id + '/withdraw', 'POST', payload)]);
  assert.ok(repeated.every(result => result.status === 200));
  assert.equal(repeated[0].data.withdrawal.id, repeated[1].data.withdrawal.id);
  assert.equal((await req('/students/' + id + '/withdraw', 'POST', { ...payload, request_id: crypto.randomUUID() })).status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM withdrawal_lines WHERE student_id = ?').bind(id).first()).n, 1);
  const another = await withdrawalStudent('不同请求并发');
  const a = await withdrawalPayload(another.id), b = { ...a, request_id: crypto.randomUUID() };
  const results = await Promise.all([req('/students/' + another.id + '/withdraw', 'POST', a), req('/students/' + another.id + '/withdraw', 'POST', b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test('withdrawal without packages remains visible in history and profile edits cannot restore archived status', async () => {
  const { id } = await withdrawalStudent('无包退学核对', []);
  const result = await ok('/students/' + id + '/withdraw', 'POST', await withdrawalPayload(id));
  assert.equal(result.lines.length, 0);
  const history = await ok('/lesson-records?student_id=' + id);
  assert.equal(history.items.length, 1); assert.equal(history.items[0].type, 'WITHDRAWAL'); assert.equal(history.items[0].lesson_package_id, null);
  const edited = await ok('/students/' + id, 'PATCH', { name: '修改资料不恢复' });
  assert.equal(edited.item.status, 'ARCHIVED'); assert.ok(edited.item.archived_at);
  assert.equal((await req('/students/' + id + '/withdraw', 'POST', await withdrawalPayload(id))).status, 409);
  assert.ok((await ok('/exports/records')).includes(result.withdrawal.id));
});

test('failure during withdrawal rolls back already inserted lines and every balance change', async () => {
  const { id, ids } = await withdrawalStudent('回滚核对', [{ paid: 3 }, { paid: 4, gift: 1 }]);
  const blocked = ids.slice().sort().at(-1);
  await db.prepare(`CREATE TRIGGER test_withdrawal_abort BEFORE INSERT ON withdrawal_lines
    WHEN NEW.lesson_package_id = '${blocked}' BEGIN SELECT RAISE(ABORT, 'TEST_ROLLBACK'); END`).run();
  try {
    assert.equal((await req('/students/' + id + '/withdraw', 'POST', await withdrawalPayload(id))).status, 500);
    assert.equal((await balances(ids[0])).paid_balance, 3); assert.equal((await balances(ids[1])).paid_balance, 4);
    assert.equal((await ok('/students/' + id)).item.status, 'ACTIVE');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM withdrawal_lines WHERE student_id = ?').bind(id).first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM student_withdrawals WHERE student_id = ?').bind(id).first()).n, 0);
  } finally { await db.prepare('DROP TRIGGER test_withdrawal_abort').run(); }
});

test('large package histories use a bounded withdrawal snapshot and clear all packages', async () => {
  const { id } = await withdrawalStudent('大量课时包结清', []);
  const learner = (await ok('/students/' + id)).item;
  await db.batch(Array.from({ length: 250 }, (_, i) => db.prepare(`INSERT INTO lesson_packages
    (id, organization_id, student_id, name, paid_balance, gift_balance, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 0, 'ARCHIVED', '2026-01-01', '2026-01-01')`)
    .bind(crypto.randomUUID(), learner.organization_id, id, '历史课时包' + i)));
  const preview = await ok('/students/' + id + '/withdrawal-preview');
  assert.equal(preview.packages.length, 250); assert.ok(preview.snapshot.length < 100);
  const payload = await withdrawalPayload(id, { remark: '退'.repeat(500) });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 16384);
  const result = await ok('/students/' + id + '/withdraw', 'POST', payload);
  assert.equal(result.lines.length, 250); assert.equal(result.lines.reduce((sum, line) => sum + line.paid_change, 0), -250);
});
