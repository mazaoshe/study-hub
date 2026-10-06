import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function page(file, request, wx = {}) {
  let definition;
  const ledgerModule = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/ledger.js', 'utf8'), { module: ledgerModule, wx, require: () => ({ request }) });
  const auth = { handleError: (p, error) => p.setData({ message: error.message }) };
  const ui = { run: async (p, action) => action(), confirm: (title, content) => new Promise(resolve => wx.showModal({ title, content, success: r => resolve(r.confirm) })) };
  const consumption = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/consume-panel.js', 'utf8'), {
    module: consumption, wx, require: name => name === './api' ? { request } : name === './auth' ? auth : name === './ledger' ? ledgerModule.exports : ui
  });
  vm.runInNewContext(await readFile('../miniprogram/pages/' + file + '/index.js', 'utf8'), {
    Page: value => { definition = value; }, wx, setTimeout: () => 1, clearTimeout: () => {},
    require: name => name.endsWith('/api') ? { request } : name.endsWith('/auth')
      ? { handleError: (p, error) => p.setData({ message: error.message }) }
      : name.endsWith('/consume-panel') ? consumption.exports : name.endsWith('/ledger') ? ledgerModule.exports : { run: async (p, action) => action(), confirm: (title, content) => new Promise(resolve => wx.showModal({ title, content, success: r => resolve(r.confirm) })) }
  });
  definition.setData = patch => Object.assign(definition.data, patch);
  return definition;
}

test('home search ignores late responses from a previous keyword and clearing restores reminder mode', async () => {
  const pending = [];
  const home = await page('home', path => new Promise(resolve => pending.push({ path, resolve })));
  home.onLoad(); home.data.identity = { role: 'ORG_ADMIN' };
  home.onSearchInput({ detail: { value: '甲' } }); const older = home.load(1);
  home.onSearchInput({ detail: { value: '乙' } }); const newer = home.load(1);
  pending[1].resolve({ students: [{ id: 'b', name: '乙', total_balance: 20, package_count: 1 }], count: 1, has_more: false });
  await newer;
  pending[0].resolve({ students: [{ id: 'a', name: '甲', total_balance: 0, package_count: 1 }], count: 1, has_more: false });
  await older;
  assert.equal(home.data.students[0].id, 'b'); assert.equal(home.data.students[0].balanceLabel, '课时充足');
  assert.equal(home.data.busy, false);
  const clearing = home.clearSearch();
  assert.equal(home.data.keyword, ''); assert.ok(pending[2].path.endsWith('search='));
  pending[2].resolve({ students: [], count: 0, has_more: false }); await clearing;
  assert.equal(home.data.loaded, true); assert.equal(home.data.students.length, 0);
});

test('home recharge navigates exactly once to the active package', async () => {
  const navigations = [];
  const home = await page('home', async () => ({ packages: [{ id: 'one', status: 'ACTIVE' }, { id: 'old', status: 'ARCHIVED' }] }),
    { showLoading() {}, hideLoading() {}, navigateTo(value) { navigations.push(value.url); value.success(); } });
  await home.operate({ currentTarget: { dataset: { id: 'student', action: 'recharge' } } });
  assert.deepEqual(navigations, ['/pages/package/index?id=one&action=recharge']);
});

test('home resolves packages before navigation, blocks duplicate taps and preserves package selection', async () => {
  let resolve;
  const navigations = [];
  const home = await page('home', () => new Promise(done => { resolve = done; }),
    { showLoading() {}, hideLoading() {}, navigateTo(value) { navigations.push(value.url); value.success(); } });
  const event = { currentTarget: { dataset: { id: 'student', action: 'recharge' } } };
  const opening = home.operate(event); await home.operate(event);
  assert.equal(navigations.length, 0);
  resolve({ packages: [{ id: 'one', status: 'ACTIVE' }, { id: 'two', status: 'ACTIVE' }] }); await opening;
  assert.deepEqual(navigations, ['/pages/student/index?id=student&action=recharge']);
  const retry = home.operate(event); resolve({ packages: [] }); await retry;
  assert.equal(navigations.length, 2);
  assert.equal(home.operating, false);
});

test('failed package lookup stays on home and allows retry', async () => {
  let calls = 0;
  const home = await page('home', async () => { calls++; throw new Error('连接失败'); },
    { showLoading() {}, hideLoading() {}, navigateTo() { assert.fail('must not navigate'); } });
  const event = { currentTarget: { dataset: { id: 'student', action: 'recharge' } } };
  await home.operate(event); await home.operate(event);
  assert.equal(calls, 2); assert.equal(home.data.message, '连接失败'); assert.equal(home.operating, false);
});

test('multiple packages require an explicit choice, and archived packages never open a charge form', async () => {
  const redirects = [], navigations = [];
  const student = await page('student', async path => path.endsWith('/packages')
    ? { packages: [{ id: 'one', status: 'ACTIVE' }, { id: 'two', status: 'ACTIVE' }, { id: 'old', status: 'ARCHIVED' }] }
    : { item: { id: 'student', status: 'ACTIVE' } },
    { redirectTo: value => redirects.push(value.url), navigateTo: value => navigations.push(value.url) });
  student.onLoad({ id: 'student', action: 'consume' }); await student.load();
  assert.equal(redirects.length, 0);
  student.open({ currentTarget: { dataset: { id: 'two' } } });
  student.open({ currentTarget: { dataset: { id: 'old' } } });
  assert.deepEqual(navigations, ['/pages/package/index?id=two&action=consume', '/pages/package/index?id=old']);
});

async function consumeHome({ packs = [{ id: 'one', name: '英语包', status: 'ACTIVE' }], confirm = true, failFirst = false } = {}) {
  const storage = new Map(), writes = [], confirmations = [];
  const wx = {
    showLoading() {}, hideLoading() {}, showToast() {},
    navigateTo() { assert.fail('home consumption must never navigate'); },
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showModal(value) { confirmations.push(value.content); value.success({ confirm }); }
  };
  const home = await page('home', async (path, method, body) => {
    if (method === 'POST') {
      writes.push({ path, body });
      if (failFirst && writes.length === 1) throw new Error('连接失败，请重试');
      return {};
    }
    if (path.includes('/dashboard')) return { students: [{ id: 'student', name: '小明', package_count: 1, total_balance: 1 }], count: 1, has_more: false };
    if (path.endsWith('/packages')) return { packages: packs };
    return { package: { id: path.split('/').pop(), student_name: '小明', student_status: 'ACTIVE', status: 'ACTIVE', paid_balance: 0, gift_balance: 1,
      courses: [{ id: 'english', name: '英语', status: 'ACTIVE' }, { id: 'old', name: '旧课程', status: 'ARCHIVED' }] } };
  }, wx);
  home.onLoad(); home.data.identity = { user: { id: 'admin' } };
  home.setData({ searchInput: '小明', keyword: '小明', students: [{ id: 'student', name: '小明' }] });
  return { home, writes, confirmations, storage };
}
const consumeEvent = { currentTarget: { dataset: { id: 'student', action: 'consume' } } };

test('home consumption stays on home, selects the single active package and refreshes balances after confirmation', async () => {
  const { home, writes, confirmations, storage } = await consumeHome();
  await home.operate(consumeEvent);
  assert.equal(home.data.consumeOpen, true); assert.equal(home.data.consumeHours, '1');
  assert.equal(home.data.consumeCourses.length, 1); assert.equal(writes.length, 0);
  await home.submitConsume();
  assert.equal(writes.length, 1); assert.equal(writes[0].path, '/packages/one/consume');
  assert.equal(writes[0].body.hours, 1); assert.equal(writes[0].body.course_id, 'english');
  assert.match(confirmations[0], /小明.*英语/); assert.match(confirmations[0], /剩余 0/);
  assert.equal(home.data.consumeOpen, false); assert.equal(home.data.searchInput, '');
  assert.equal(home.data.keyword, '小明'); assert.equal(home.data.students[0].id, 'student');
  assert.equal(home.data.students[0].total_balance, 1); assert.equal(home.data.searchFocus, true); assert.equal(storage.size, 0);
  home.onSearchInput({ detail: { value: '小红' } });
  assert.equal(home.data.keyword, '小红'); assert.equal(home.data.students.length, 0);
});

test('multiple packages require selection inside the panel, invalid hours and cancelled confirmations never write', async () => {
  const { home, writes } = await consumeHome({ packs: [{ id: 'one', name: '英语包', status: 'ACTIVE' }, { id: 'two', name: '阅读包', status: 'ACTIVE' }], confirm: false });
  await home.operate(consumeEvent); await home.submitConsume();
  assert.equal(home.data.consumePackage, null); assert.equal(writes.length, 0);
  await home.chooseConsumePackage({ detail: { value: '2' } });
  assert.equal(home.data.consumePackage.id, 'two');
  home.data.consumeHours = '1.5'; await home.submitConsume();
  home.data.consumeHours = '1'; await home.submitConsume();
  assert.equal(writes.length, 0); assert.equal(home.data.consumeOpen, true); assert.equal(home.data.consumeBusy, false);
  home.closeConsume(); assert.equal(home.data.consumeOpen, false);
});

test('failed home consumption preserves the form and idempotency key; duplicate submit does not charge again', async () => {
  const { home, writes, confirmations, storage } = await consumeHome({ failFirst: true });
  await home.operate(consumeEvent); home.data.consumeHours = '2';
  const first = home.submitConsume(); await home.submitConsume(); await first;
  assert.equal(writes.length, 1); assert.equal(home.data.consumeOpen, true); assert.equal(home.data.consumeHours, '2');
  assert.match(home.data.consumeMessage, /连接失败/); assert.equal(storage.size, 1);
  await home.submitConsume();
  assert.equal(writes.length, 2); assert.equal(writes[0].body.request_id, writes[1].body.request_id);
  assert.match(confirmations[0], /透支 1/); assert.equal(storage.size, 0); assert.equal(home.data.consumeOpen, false);
});


async function archiveHome({ confirm = true, failWrite = false, failRefresh = false } = {}) {
  const calls = [], confirmations = [], toasts = [];
  const home = await page('home', async (path, method, body) => {
    calls.push({ path, method, body });
    if (method === 'PATCH') { if (failWrite) throw new Error('归档失败'); return {}; }
    if (failRefresh) throw new Error('刷新失败');
    return { students: [{ id: 'two', name: '小红', total_balance: 1, package_count: 1 }], count: 1, has_more: false };
  }, {
    showModal(options) { confirmations.push(options.content); options.success({ confirm }); },
    showToast: options => toasts.push(options.title),
    navigateTo() { assert.fail('archive must stay on home'); }
  });
  home.onLoad(); home.setData({ identity: { user: { id: 'admin' } }, loaded: true, count: 2,
    students: [{ id: 'one', name: '小明', total_balance: -1 }, { id: 'two', name: '小红', total_balance: 1 }] });
  return { home, calls, confirmations, toasts };
}
const archiveEvent = { currentTarget: { dataset: { id: 'one' } } };

test('home archive confirms named student once, stays on home and refreshes the active filter and count', async () => {
  const { home, calls, confirmations, toasts } = await archiveHome();
  home.setData({ keyword: '小', searchInput: '小' });
  const pending = home.archive(archiveEvent); await home.archive(archiveEvent);
  await home.operate({ currentTarget: { dataset: { id: 'one', action: 'recharge' } } });
  home.onSearchInput({ detail: { value: '别的学员' } });
  await pending;
  assert.equal(confirmations.length, 1); assert.match(confirmations[0], /小明/); assert.match(confirmations[0], /已归档/);
  assert.equal(calls.length, 2); assert.equal(calls[0].path, '/students/one');
  assert.equal(calls[0].method, 'PATCH'); assert.equal(calls[0].body.status, 'ARCHIVED');
  assert.equal(calls[1].path, '/dashboard?page=1&search=' + encodeURIComponent('小'));
  assert.equal(home.data.students.length, 1); assert.equal(home.data.students[0].id, 'two');
  assert.equal(home.data.count, 1); assert.equal(home.data.archivingId, ''); assert.deepEqual(toasts, ['已归档']);
});

test('cancelled or failed home archive leaves the student and count unchanged', async () => {
  for (const options of [{ confirm: false }, { failWrite: true }]) {
    const { home, calls, toasts } = await archiveHome(options);
    await home.archive(archiveEvent);
    assert.equal(home.data.students.length, 2); assert.equal(home.data.count, 2); assert.equal(home.data.archivingId, '');
    assert.equal(calls.length, options.failWrite ? 1 : 0); assert.equal(toasts.length, 0);
    if (options.failWrite) assert.equal(home.data.message, '归档失败');
  }
});

test('confirmed archive stays removed if refresh fails, and open consumption blocks archiving', async () => {
  const { home, calls } = await archiveHome({ failRefresh: true });
  home.setData({ consumeOpen: true }); await home.archive(archiveEvent); assert.equal(calls.length, 0);
  home.setData({ consumeOpen: false }); await home.archive(archiveEvent);
  assert.equal(home.data.students.length, 1); assert.equal(home.data.students[0].id, 'two');
  assert.equal(home.data.count, 1); assert.equal(home.data.message, '刷新失败');
  assert.equal(home.data.archivingId, ''); assert.equal(home.data.busy, false);
});
