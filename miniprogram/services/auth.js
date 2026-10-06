const { request } = require('./api');

function freshCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      timeout: 10000,
      success(result) {
        if (!result.code) { reject(new Error('无法获取微信登录凭证，请重试')); return; }
        resolve(result.code);
      },
      fail() { reject(new Error('微信登录失败，请重试')); }
    });
  });
}

async function login(onRetry) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // A timed-out request may have already consumed its code. Always get a new one.
      const code = await freshCode();
      const session = await request('/auth/login', 'POST', { code }, { timeout: 25000 });
      wx.setStorageSync('session_token', session.token);
      return { user: session.user, role: session.role, organization: session.organization, needs_binding: session.needs_binding };
    } catch (error) {
      const retryable = ['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'WECHAT_UNAVAILABLE'].includes(error.code);
      if (attempt || !retryable) throw error;
      if (onRetry) onRetry();
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}

function enter(identity) {
  const url = identity.role === 'SUPER_ADMIN' ? '/pages/organizations/index' :
    identity.needs_binding ? '/pages/login/index' : '/pages/home/index';
  wx.reLaunch({ url });
}

function handleError(page, error) {
  page.setData({ message: error.message || '操作失败' });
  if (error.status === 401 || error.code === 'USER_DISABLED' || error.code === 'ORGANIZATION_DISABLED') {
    wx.reLaunch({ url: '/pages/login/index' });
  }
}
module.exports = { login, enter, handleError };
