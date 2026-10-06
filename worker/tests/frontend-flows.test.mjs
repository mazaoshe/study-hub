import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function page(file, request, wx = {}) {
  const auth = { handleError: (page, error) => page.setData({ message: error.message }) };
  const ui = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/ui.js', 'utf8'), {
    module: ui, wx, require: name => name === './api' ? { request } : auth
  });
  const ledgerModule = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/ledger.js', 'utf8'), { module: ledgerModule, wx, require: () => ({ request }) });
  const consumption = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/consume-panel.js', 'utf8'), {
    module: consumption, wx, require: name => name === './api' ? { request } : name === './auth' ? auth : name === './ledger' ? ledgerModule.exports : ui.exports
  });
  const catalogModule = { exports: {} };
  vm.runInNewContext(await readFile('../miniprogram/services/catalog-page.js', 'utf8'), {
    module: catalogModule, wx, require: name => name === './api' ? { request } : name === './consume-panel' ? consumption.exports : ui.exports
  });
  let definition;
  vm.runInNewContext(await readFile('../miniprogram/pages/' + file + '/index.js', 'utf8'), {
    Page: value => { definition = value; }, wx,
    require: name => name.endsWith('/api') ? { request } : name.endsWith('/ui') ? ui.exports : name.endsWith('/catalog-page') ? catalogModule.exports : {}
  });
  definition.setData = (patch, callback) => { Object.assign(definition.data, patch); if (callback) callback(); };
  return definition;
}
async function operation(confirm = true) {
  const confirmations = [], writes = [];
  const pack = await page('package', async () => ({}), {
    showModal(value) { confirmations.push(value); value.success({ confirm }); }, showToast() {}
  });
  pack.setData({ package: { id: 'pack', name: '英语包', student_name: '小明', status: 'ACTIVE', student_status: 'ACTIVE', paid_balance: 2, gift_balance: 1 },
    activeCourses: [{ id: 'english', name: '英语', status: 'ACTIVE' }] });
  pack.send = async (action, body) => { writes.push({ action, body }); };
  pack.load = async () => {};
  return { pack, confirmations, writes };
}

test('package consumption starts at one hour and quick choice is confirmed with student and overdraft', async () => {
  const { pack, confirmations, writes } = await operation();
  pack.mode({ currentTarget: { dataset: { mode: 'consume' } } }); assert.equal(pack.data.hours, '1');
  pack.quickHours({ currentTarget: { dataset: { hours: 3 } } }); assert.equal(pack.data.hours, '3');
  pack.data.hours = '4'; await pack.submit();
  assert.match(confirmations[0].content, /小明.*英语/); assert.match(confirmations[0].content, /消课后共 -1/);
  assert.match(confirmations[0].content, /透支 1/); assert.equal(writes[0].body.hours, 4); assert.equal(writes[0].body.course_id, 'english');
});

test('recharge confirmation includes student, package, both additions and resulting balance', async () => {
  const { pack, confirmations, writes } = await operation();
  pack.mode({ currentTarget: { dataset: { mode: 'recharge' } } }); pack.setData({ paid: '5', gift: '2' }); await pack.submit();
  assert.match(confirmations[0].content, /小明.*英语包/); assert.match(confirmations[0].content, /付费增加 5/);
  assert.match(confirmations[0].content, /赠送增加 2/); assert.match(confirmations[0].content, /充值后共 10/);
  assert.equal(writes[0].action, 'recharge');
});

test('cancelled confirmation and archived package cannot record operations', async () => {
  const { pack, confirmations, writes } = await operation(false);
  pack.mode({ currentTarget: { dataset: { mode: 'consume' } } }); await pack.submit();
  assert.equal(writes.length, 0); assert.equal(pack.data.hours, '1'); assert.equal(pack.data.mode, 'consume');
  pack.data.package.status = 'ARCHIVED'; await pack.submit();
  assert.equal(confirmations.length, 1); assert.equal(writes.length, 0); assert.match(pack.data.message, /正常课时包/);
});

test('new student goes directly to package creation while student edits and courses stay in the catalog', async () => {
  for (const [kind, editId] of [['students', ''], ['students', 'existing'], ['courses', '']]) {
    const navigations = [], calls = [];
    const catalog = await page('catalog', async (path, method) => { calls.push({ path, method }); return method ? { item: { id: 'new' } } : { items: [], has_more: false }; },
      { navigateTo: value => navigations.push(value.url) });
    catalog.setData({ kind, editId, name: '新学员', editing: true }); await catalog.save();
    assert.equal(catalog.data.editing, false);
    if (kind === 'students' && !editId) { assert.deepEqual(navigations, ['/pages/student/index?id=new&create=1']); assert.equal(calls.length, 1); }
    else { assert.equal(navigations.length, 0); assert.equal(calls.length, 2); }
  }
});

test('student creation entry opens course selection once and refreshes courses after returning', async () => {
  let courses = [{ id: 'english', name: '英语' }];
  const student = await page('student', async path => path === '/courses?page=1' ? { items: courses, has_more: false }
    : path.endsWith('/packages') ? { packages: [] } : { item: { id: 'new', status: 'ACTIVE' } });
  student.onLoad({ id: 'new', create: '1' }); await student.onShow();
  assert.equal(student.data.creating, true); assert.equal(student.data.courses.length, 1);
  student.data.selected = ['english']; courses = [...courses, { id: 'reading', name: '阅读' }]; await student.onShow();
  assert.equal(student.data.courses.length, 2); assert.equal(student.data.courses[0].checked, true);
  student.cancel(); await student.onShow(); assert.equal(student.data.creating, false);
});

test('failed student creation preserves input and does not open package creation', async () => {
  const catalog = await page('catalog', async () => { throw new Error('保存失败'); }, { navigateTo() { assert.fail('must stay on form'); } });
  catalog.setData({ name: '小明', editing: true }); await catalog.save();
  assert.equal(catalog.data.name, '小明'); assert.equal(catalog.data.editing, true); assert.equal(catalog.data.message, '保存失败');
});

test('legacy records preserve raw dates and zero hours, pagination and package scope when switching', async () => {
  const calls = [];
  const records = await page('records', async path => {
    calls.push(path);
    if (path.startsWith('/legacy-records')) return { items: [{ id: 'old', action: 'add', hours: 0, source_created_at: '2020-01-02T08:30:00', use_date: null }], has_more: false };
    return { items: [], has_more: false };
  });
  records.onLoad({ kind: 'legacy', package_id: 'my-package' });
  await records.load(1);
  assert.equal(calls[0], '/legacy-records?page=1&package_id=my-package');
  assert.equal(records.data.items[0].hoursText, '+0');
  assert.equal(records.data.items[0].time, '2020-01-02 08:30:00');
  assert.equal(records.data.items[0].useDate, '');
  await records.switchKind();
  assert.equal(calls[1], '/lesson-records?page=1&package_id=my-package');
  assert.equal(records.data.items.length, 0);
});

test('student list defaults to active, paginates and searches within the selected status', async () => {
  const calls = [];
  const catalog = await page('catalog', async path => {
    calls.push(path);
    const url = new URL(path, 'https://test.local');
    if (url.searchParams.get('search')) return { items: [], total: 0, has_more: false };
    const second = url.searchParams.get('page') === '2';
    return { items: Array.from({ length: second ? 2 : 20 }, (_, i) => ({ id: String(i + (second ? 20 : 0)) })), total: 22, has_more: !second };
  });
  catalog.onLoad({ kind: 'students' }); await catalog.onShow();
  assert.equal(catalog.data.archived, false); assert.equal(catalog.data.total, 22);
  assert.ok(calls[0].endsWith('&status=ACTIVE'));
  catalog.input({ currentTarget: { dataset: { field: 'searchInput' } }, detail: { value: '188888' } });
  await catalog.onReachBottom();
  assert.equal(catalog.data.items.length, 22); assert.equal(new Set(catalog.data.items.map(i => i.id)).size, 22);
  assert.ok(calls[1].includes('page=2&search=&'));
  await catalog.more(); assert.equal(calls.length, 2);
  await catalog.search();
  assert.equal(catalog.data.page, 1); assert.equal(catalog.data.total, 0); assert.equal(catalog.data.items.length, 0);
  assert.ok(calls[2].includes('search=188888'));
  await catalog.selectStatus({ currentTarget: { dataset: { status: 'ARCHIVED' } } });
  assert.ok(calls.at(-1).endsWith('&status=ARCHIVED')); assert.ok(calls.at(-1).includes('page=1&search=188888'));
  assert.equal(catalog.data.archived, true);
  await catalog.selectStatus({ currentTarget: { dataset: { status: 'ACTIVE' } } });
  assert.ok(calls.at(-1).endsWith('&status=ACTIVE'));
  catalog.onLoad({ kind: 'courses' }); assert.equal(catalog.data.archived, false);
});

test('student tab always loads students and shares search, archive and detail operations with the catalog', async () => {
  const calls = [], navigations = [];
  const students = await page('students', async path => { calls.push(path); return { items: [{ id: 'one', name: '小明' }], total: 1, has_more: false }; },
    { navigateTo: value => navigations.push(value.url) });
  students.onLoad({ kind: 'courses' }); await students.onShow();
  assert.equal(students.data.kind, 'students'); assert.equal(students.data.archived, false);
  assert.ok(calls[0].startsWith('/students?')); assert.equal(students.data.items[0].id, 'one');
  students.detail({ currentTarget: { dataset: { id: 'one' } } });
  assert.deepEqual(navigations, ['/pages/student/index?id=one']);
  students.data.searchInput = '18888'; await students.search(); assert.ok(calls.at(-1).includes('search=18888'));
});

test('student sort resets pagination, persists across archive switching and applies to later pages', async () => {
  const calls = [];
  const students = await page('students', async path => { calls.push(path); return { items: [], total: 0, has_more: true }; });
  students.onLoad(); await students.onShow(); assert.ok(calls.at(-1).includes('sort=name'));
  students.setData({ page: 3, items: [{ id: 'old' }] });
  await students.sort({ detail: { value: '1' } });
  assert.equal(students.data.page, 1); assert.equal(students.data.items.length, 0);
  assert.ok(calls.at(-1).includes('sort=balance'));
  await students.more(); assert.ok(calls.at(-1).includes('page=2')); assert.ok(calls.at(-1).includes('sort=balance'));
  await students.selectStatus({ currentTarget: { dataset: { status: 'ARCHIVED' } } });
  assert.ok(calls.at(-1).includes('sort=archived'));
  await students.selectStatus({ currentTarget: { dataset: { status: 'ACTIVE' } } });
  assert.ok(calls.at(-1).includes('sort=balance'));
  await students.sort({ detail: { value: '2' } }); assert.ok(calls.at(-1).includes('sort=newest'));
});

test('student cards hide only the imported identifier while preserving business notes and balances', async () => {
  const students = await page('students', async () => ({ items: [
    { id: 'one', name: '小明', remark: 'StudyHub 旧学员编号 83\n周六上课', paid_balance: -2, gift_balance: 0, total_balance: -2, package_count: 1 },
    { id: 'two', name: '小红', remark: 'StudyHub 旧学员编号 84', paid_balance: 1, gift_balance: 1, total_balance: 2, package_count: 2 }
  ], total: 2, has_more: false }));
  students.onLoad(); await students.onShow();
  assert.equal(students.data.items[0].displayRemark, '周六上课'); assert.equal(students.data.items[1].displayRemark, '');
  assert.equal(students.data.items[0].total_balance, -2); assert.equal(students.data.items[0].balanceClass, 'negative');
  assert.equal(students.data.items[1].balanceClass, 'low-balance');
  students.edit({ currentTarget: { dataset: { id: 'one' } } }); assert.equal(students.data.remark, '周六上课');
});


test('switching student status clears old rows even on failure, and archive/restore refresh their own list', async () => {
  let status = 'ACTIVE', fail = false;
  const calls = [];
  const students = await page('students', async (path, method, body) => {
    calls.push(path);
    if (method === 'PATCH') { status = body.status; return {}; }
    if (fail) throw new Error('加载失败');
    const visible = new URL(path, 'https://test.local').searchParams.get('status') === status;
    return { items: visible ? [{ id: 'one', name: '小明', status }] : [], total: visible ? 1 : 0, has_more: false };
  }, { showModal: value => value.success({ confirm: true }) });
  const choose = status => students.selectStatus({ currentTarget: { dataset: { status } } });
  const toggle = () => students.toggle({ currentTarget: { dataset: { id: 'one' } } });
  students.onLoad(); await students.onShow();
  assert.equal(students.data.items.length, 1);
  await toggle(); assert.equal(status, 'ARCHIVED'); assert.equal(students.data.items.length, 0);
  await choose('ARCHIVED'); assert.equal(students.data.items.length, 1); assert.equal(students.data.total, 1);
  const previousCalls = calls.length;
  await choose('ARCHIVED'); assert.equal(calls.length, previousCalls);
  students.data.busy = true; await choose('ACTIVE'); assert.equal(students.data.archived, true); students.data.busy = false;
  await toggle(); assert.equal(status, 'ACTIVE'); assert.equal(students.data.items.length, 0);
  await choose('ACTIVE'); assert.equal(students.data.items.length, 1);
  students.setData({ page: 2, hasMore: true, editing: true }); fail = true;
  await choose('ARCHIVED');
  assert.equal(students.data.items.length, 0); assert.equal(students.data.page, 1);
  assert.equal(students.data.hasMore, false); assert.equal(students.data.total, null);
  assert.equal(students.data.loaded, false); assert.equal(students.data.editing, false);
  assert.equal(students.data.message, '加载失败');
});


test('student quick actions resolve active packages once and never write ledger data', async () => {
  for (const action of ['recharge']) {
    for (const count of [0, 1, 2]) {
      const calls = [], navigations = [];
      let release;
      const students = await page('students', async (path, method) => {
        assert.equal(method, undefined); calls.push(path);
        return new Promise(resolve => { release = () => resolve({ packages: [{ id: 'old', status: 'ARCHIVED' }, ...Array.from({ length: count }, (_, i) => ({ id: 'pack' + i, status: 'ACTIVE' }))] }); });
      }, { navigateTo: options => { navigations.push(options.url); options.success(); } });
      students.setData({ items: [{ id: 'one', status: 'ACTIVE' }] });
      const event = { currentTarget: { dataset: { id: 'one', action } } };
      const pending = students.operate(event); await students.operate(event);
      assert.equal(calls.length, 1); assert.equal(navigations.length, 0);
      release(); await pending;
      assert.equal(navigations.length, 1);
      assert.equal(navigations[0], count === 1 ? '/pages/package/index?id=pack0&action=' + action : '/pages/student/index?id=one&action=' + action);
      students.data.items[0].status = 'ARCHIVED'; await students.operate(event);
      assert.equal(calls.length, 1);
    }
  }
});

test('failed quick action stays in list and can be retried', async () => {
  let fail = true, navigations = 0;
  const students = await page('students', async () => {
    if (fail) throw new Error('网络异常');
    return { packages: [{ id: 'pack', status: 'ACTIVE' }] };
  }, { navigateTo: options => { navigations++; options.success(); } });
  students.setData({ items: [{ id: 'one', status: 'ACTIVE' }] });
  const event = { currentTarget: { dataset: { id: 'one', action: 'recharge' } } };
  await students.operate(event); assert.equal(navigations, 0); assert.equal(students.data.message, '网络异常');
  assert.equal(students.data.busy, false); fail = false;
  await students.operate(event); assert.equal(navigations, 1);
});

test('returning to student list refreshes all loaded pages atomically and restores scroll and filters', async () => {
  let version = 1, failedPage = 0;
  const scrolls = [], calls = [];
  const students = await page('students', async path => {
    calls.push(path);
    const pageNumber = Number(new URL(path, 'https://test.local').searchParams.get('page'));
    if (pageNumber === failedPage) throw new Error('刷新失败');
    return { items: Array.from({ length: pageNumber === 1 ? 20 : 2 }, (_, i) => ({ id: String((pageNumber - 1) * 20 + i), total_balance: version })), total: 22, has_more: pageNumber === 1 };
  }, { pageScrollTo: options => scrolls.push(options.scrollTop) });
  students.onLoad(); students.setData({ search: '小明', searchInput: '小明', sortIndex: 1 });
  await students.onShow(); await students.more(); students.onPageScroll({ scrollTop: 3500 }); version = 2;
  await students.onShow();
  assert.equal(students.data.items.length, 22); assert.equal(students.data.page, 2);
  assert.ok(students.data.items.every(item => item.total_balance === 2)); assert.equal(scrolls.at(-1), 3500);
  assert.ok(calls.slice(-2).every(path => path.includes('sort=balance') && path.includes('search=' + encodeURIComponent('小明'))));
  version = 3; failedPage = 2; await students.onShow();
  assert.equal(students.data.items.length, 22); assert.ok(students.data.items.every(item => item.total_balance === 2));
  assert.equal(students.data.message, '刷新失败'); assert.equal(students.data.page, 2);
  failedPage = 0; await students.onShow(); assert.ok(students.data.items.every(item => item.total_balance === 3));
});

test('student more menu cancels safely, edits in place and preserves form during failed or pending save', async () => {
  let choice = -1, release;
  const students = await page('students', async () => new Promise((resolve, reject) => { release = () => reject(new Error('保存失败')); }), {
    showActionSheet: options => choice < 0 ? options.fail() : options.success({ tapIndex: choice })
  });
  students.setData({ items: [{ id: 'one', status: 'ACTIVE', name: '小明', phone: '123', remark: '备注' }], loaded: true });
  const event = { currentTarget: { dataset: { id: 'one' } } };
  await students.moreActions(event); assert.equal(students.data.editing, false);
  choice = 0; await students.moreActions(event); assert.equal(students.data.editing, true); assert.equal(students.data.name, '小明');
  students.setData({ name: '新名字' });
  const pending = students.save(); students.cancel(); assert.equal(students.data.editing, true);
  release(); await pending; assert.equal(students.data.editing, true); assert.equal(students.data.name, '新名字');
  assert.equal(students.data.message, '保存失败'); students.cancel(); assert.equal(students.data.editing, false);
});

test('package groups stay separate across archive and restore, and archived packages open without an action', async () => {
  let packages = [{ id: 'active', status: 'ACTIVE', paid_balance: 2, gift_balance: 1 }, { id: 'archive', status: 'ARCHIVED', paid_balance: 5, gift_balance: 0 }];
  const navigations = [];
  const student = await page('student', async path => path.endsWith('/packages') ? { packages } : { item: { id: 'one', status: 'ACTIVE' } },
    { navigateTo: options => navigations.push(options.url) });
  student.onLoad({ id: 'one', action: 'consume' }); await student.onShow();
  assert.equal(student.data.activeCount, 1); assert.equal(student.data.archivedCount, 1);
  assert.equal(student.data.visiblePackages.length, 1); assert.equal(student.data.visiblePackages[0].id, 'active');
  student.open({ currentTarget: { dataset: { id: 'active' } } }); assert.ok(navigations.at(-1).endsWith('&action=consume'));
  student.switchPackages({ currentTarget: { dataset: { status: 'ARCHIVED' } } });
  assert.equal(student.data.visiblePackages.length, 1); assert.equal(student.data.visiblePackages[0].id, 'archive');
  student.open({ currentTarget: { dataset: { id: 'archive' } } }); assert.equal(navigations.at(-1), '/pages/package/index?id=archive');
  packages = packages.map(item => ({ ...item, status: 'ACTIVE' })); await student.onShow();
  assert.equal(student.data.visiblePackages.length, 0); assert.equal(student.data.archivedCount, 0); assert.equal(student.data.activeCount, 2);
  student.switchPackages({ currentTarget: { dataset: { status: 'ACTIVE' } } }); assert.equal(student.data.visiblePackages.length, 2);
});


test('editing business notes hides import identifiers while preserving stored metadata on save', async () => {
  const writes = [];
  const students = await page('students', async (path, method, body) => {
    if (method) { writes.push(body); return {}; }
    return { items: [{ id: 'one', remark: writes.at(-1).remark }], has_more: false };
  });
  students.setData({ items: [{ id: 'one', name: '小明', remark: 'StudyHub 旧学员编号 83\n周六上课' }] });
  const event = { currentTarget: { dataset: { id: 'one' } } };
  students.edit(event); assert.equal(students.data.remark, '周六上课');
  await students.save(); assert.equal(writes[0].remark, 'StudyHub 旧学员编号 83\n周六上课');
  students.edit(event); students.setData({ remark: '周日上课' }); await students.save();
  assert.equal(writes[1].remark, 'StudyHub 旧学员编号 83\n周日上课');
  students.edit(event); students.setData({ remark: '' }); await students.save();
  assert.equal(writes[2].remark, 'StudyHub 旧学员编号 83');
});

async function consumingStudentList({ count = 1, failFirst = false, confirm = true } = {}) {
  const storage = new Map(), writes = [], scrolls = [], reads = [];
  const students = await page('students', async (path, method, payload) => {
    reads.push(path);
    if (method === 'POST') { writes.push(payload); if (failFirst && writes.length === 1) throw new Error('结果未确认，请重试'); return {}; }
    if (path === '/me') return { user: { id: 'admin' } };
    if (path.endsWith('/packages')) return { packages: Array.from({ length: count }, (_, index) => ({ id: 'pack' + index, name: '英语包', status: 'ACTIVE' })) };
    if (path.startsWith('/packages/')) return { package: { id: path.split('/').pop(), name: '英语包', student_name: '小明', status: 'ACTIVE', student_status: 'ACTIVE',
      paid_balance: 5, gift_balance: 0, courses: [{ id: 'english', name: '英语', status: 'ACTIVE' }] } };
    return { items: [{ id: 'one', name: '小明', status: 'ACTIVE', total_balance: 4, package_count: 1 }], total: 1, has_more: false };
  }, {
    navigateTo() { assert.fail('consume must stay on student tab'); }, showToast() {}, pageScrollTo: options => scrolls.push(options.scrollTop),
    showModal: options => options.success({ confirm }), getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key)
  });
  students.onLoad(); students.setData({ loaded: true, search: '小明', searchInput: '小明', items: [{ id: 'one', name: '小明', status: 'ACTIVE', package_count: count }] });
  students.scrollTop = 520;
  return { students, writes, scrolls, reads, storage };
}
const quickConsumption = { currentTarget: { dataset: { id: 'one', action: 'consume' } } };

test('student consumption stays in list and refreshes balances without losing search or scroll position', async () => {
  const { students, writes, scrolls } = await consumingStudentList();
  await students.operate(quickConsumption); assert.equal(students.data.consumeOpen, true); assert.equal(writes.length, 0);
  assert.equal(students.data.consumeHours, '1'); await students.submitConsume();
  assert.equal(writes.length, 1); assert.equal(writes[0].hours, 1); assert.equal(writes[0].course_id, 'english');
  assert.equal(students.data.items[0].total_balance, 4); assert.equal(students.data.search, '小明');
  assert.equal(students.data.searchInput, ''); assert.equal(students.data.consumeOpen, false); assert.equal(scrolls.at(-1), 520);
});

test('student consume panel requires multiple-package selection and cancellation never writes', async () => {
  const { students, writes } = await consumingStudentList({ count: 2, confirm: false });
  await students.operate(quickConsumption); assert.equal(students.data.consumePackage, null);
  await students.submitConsume(); assert.equal(writes.length, 0);
  await students.chooseConsumePackage({ detail: { value: 2 } }); assert.equal(students.data.consumePackage.id, 'pack1');
  await students.submitConsume(); assert.equal(writes.length, 0); assert.equal(students.data.consumeOpen, true);
  students.closeConsume(); assert.equal(students.data.consumeOpen, false);
});

test('student consumption preserves failed input and idempotency key and rejects duplicate submits', async () => {
  const { students, writes, storage } = await consumingStudentList({ failFirst: true });
  await students.operate(quickConsumption); students.data.consumeHours = '2';
  const submitting = students.submitConsume(); await students.submitConsume(); await submitting;
  assert.equal(writes.length, 1); assert.equal(students.data.consumeOpen, true); assert.equal(students.data.consumeHours, '2');
  assert.match(students.data.consumeMessage, /重试/); assert.equal(storage.size, 1);
  await students.submitConsume(); assert.equal(writes.length, 2); assert.equal(writes[0].request_id, writes[1].request_id);
  assert.equal(storage.size, 0); assert.equal(students.data.consumeOpen, false);
});
