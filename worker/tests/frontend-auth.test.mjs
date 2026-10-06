import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('../miniprogram/services/auth.js', 'utf8');
function client(request) {
  const storage = new Map();
  let code = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: () => ({ request }), setTimeout: fn => { fn(); }, wx: {
    login: options => options.success({ code: 'fresh-' + ++code }),
    setStorageSync: (key, value) => storage.set(key, value)
  } });
  return { login: module.exports.login, storage, attempts: () => code };
}
const session = { token: 'test-only-token', user: { id: 'member' }, role: 'ORG_ADMIN', organization: { id: 'org' }, needs_binding: false };

test('network timeout retries login with a fresh WeChat code and saves only successful session', async () => {
  const calls = [];
  const app = client(async (path, method, body, options) => {
    calls.push(body.code); assert.equal(path, '/auth/login'); assert.equal(method, 'POST'); assert.equal(options.timeout, 25000);
    if (calls.length === 1) throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
    return session;
  });
  let notices = 0;
  const identity = await app.login(() => notices++);
  assert.deepEqual(calls, ['fresh-1', 'fresh-2']); assert.equal(notices, 1);
  assert.equal(identity.token, undefined); assert.equal(identity.role, 'ORG_ADMIN');
  assert.equal(app.storage.get('session_token'), session.token);
});

test('WeChat temporary failure is retried once; repeated failures stop without a session', async () => {
  const app = client(async () => { throw Object.assign(new Error('unavailable'), { code: 'WECHAT_UNAVAILABLE' }); });
  await assert.rejects(app.login(), /unavailable/);
  assert.equal(app.attempts(), 2); assert.equal(app.storage.size, 0);
});

test('expired credentials, disabled accounts and missing configuration are not blindly retried', async () => {
  for (const code of ['WECHAT_CODE_INVALID', 'USER_DISABLED', 'AUTH_NOT_CONFIGURED']) {
    const app = client(async () => { throw Object.assign(new Error(code), { code }); });
    await assert.rejects(app.login(), error => error.code === code);
    assert.equal(app.attempts(), 1); assert.equal(app.storage.size, 0);
  }
});
