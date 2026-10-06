import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const preview = { student: { id: 'student', name: '小明', status: 'ACTIVE' }, packages: [{ id: 'pack', name: '课时包', paid_balance: 5, gift_balance: 2 }], snapshot: '[0,[["pack",5,2,"ACTIVE",1]]]', blocked_reason: '' };
async function makePage(request, wx) {
  const ui = { exports: {} }, service = { exports: {} };
  const auth = { handleError: (page, error) => page.setData({ message: error.message }) };
  vm.runInNewContext(await readFile('../miniprogram/services/ui.js', 'utf8'), { module: ui, wx, require: name => name === './api' ? { request } : auth });
  vm.runInNewContext(await readFile('../miniprogram/services/withdrawal.js', 'utf8'), { module: service, wx, require: () => ({ request }) });
  let page;
  vm.runInNewContext(await readFile('../miniprogram/pages/withdraw/index.js', 'utf8'), {
    Page: definition => { page = definition; }, wx,
    require: name => name.endsWith('/api') ? { request } : name.endsWith('/ui') ? ui.exports : service.exports
  });
  page.setData = patch => Object.assign(page.data, patch); page.onLoad({ id: 'student' }); return page;
}
function environment(confirm = true) {
  const storage = new Map(), confirmations = [], toasts = [];
  return { storage, confirmations, toasts, wx: {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showModal: options => { confirmations.push(options.content); options.success({ confirm }); },
    showToast: options => toasts.push(options.title)
  } };
}

test('withdrawal requires offline refund acknowledgement and cancellation never clears hours', async () => {
  const env = environment(false), writes = [];
  const page = await makePage(async (path, method, body) => {
    if (method) { writes.push(body); return {}; }
    return path === '/me' ? { user: { id: 'admin' } } : preview;
  }, env.wx);
  await page.onShow(); await page.submit();
  assert.equal(env.confirmations.length, 0); assert.equal(writes.length, 0);
  page.acknowledge({ detail: { value: ['confirmed'] } }); await page.submit();
  assert.equal(env.confirmations.length, 1); assert.equal(writes.length, 0); assert.equal(env.storage.size, 0);
  assert.match(env.confirmations[0], /小明/); assert.match(env.confirmations[0], /不能恢复/);
});

test('lost withdrawal response retains exact intent and preview across reopen, retry completes once', async () => {
  const env = environment(), writes = [];
  let previewReads = 0;
  const request = async (path, method, body) => {
    if (path === '/me') return { user: { id: 'admin' } };
    if (!method) { previewReads++; return preview; }
    assert.equal(path, '/students/student/withdraw'); writes.push(body);
    if (writes.length === 1) throw new Error('网络超时');
    return { withdrawal: { id: 'same-result' } };
  };
  let page = await makePage(request, env.wx); await page.onShow();
  page.acknowledge({ detail: { value: ['confirmed'] } }); page.input({ detail: { value: '已退费' } });
  const first = page.submit(); await page.submit(); await first;
  assert.equal(writes.length, 1); assert.equal(page.data.retrying, true); assert.equal(env.storage.size, 1);
  page = await makePage(request, env.wx); await page.onShow();
  assert.equal(previewReads, 1); assert.equal(page.data.remark, '已退费'); assert.equal(page.data.confirmed, false);
  page.input({ detail: { value: '不能改掉待确认的内容' } }); assert.equal(page.data.remark, '已退费');
  page.acknowledge({ detail: { value: ['confirmed'] } }); await page.submit();
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.equal(page.data.done, true); assert.equal(env.storage.size, 0); assert.equal(env.toasts.length, 1);
});

test('changed balances discard definitively rejected intent and require renewed preview and acknowledgement', async () => {
  const env = environment(); let next = preview, reads = 0;
  const page = await makePage(async (path, method) => {
    if (path === '/me') return { user: { id: 'admin' } };
    if (!method) { reads++; return next; }
    const error = new Error('余额已变化'); error.code = 'WITHDRAWAL_BALANCE_CHANGED'; throw error;
  }, env.wx);
  await page.onShow(); page.acknowledge({ detail: { value: ['confirmed'] } }); await page.submit();
  assert.equal(env.storage.size, 0); assert.equal(page.data.confirmed, false); assert.equal(page.data.retrying, false);
  assert.match(page.data.preview.blocked_reason, /重新核对/);
  next = { ...preview, snapshot: '[0,[]]' }; await page.reload();
  assert.equal(reads, 2); assert.equal(page.data.preview.snapshot, '[0,[]]'); assert.equal(page.data.confirmed, false);
});

test('definitive oversized-request rejection does not trap the page in an uneditable retry', async () => {
  const env = environment();
  const page = await makePage(async (path, method) => {
    if (path === '/me') return { user: { id: 'admin' } };
    if (!method) return preview;
    const error = new Error('内容过长'); error.code = 'PAYLOAD_TOO_LARGE'; throw error;
  }, env.wx);
  await page.onShow(); page.acknowledge({ detail: { value: ['confirmed'] } }); await page.submit();
  assert.equal(env.storage.size, 0); assert.equal(page.data.retrying, false); assert.equal(page.data.confirmed, false);
  page.input({ detail: { value: '可以编辑' } }); assert.equal(page.data.remark, '可以编辑');
  await page.reload(); assert.equal(page.data.preview.blocked_reason, '');
});
