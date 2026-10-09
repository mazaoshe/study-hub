const { request } = require('../../services/api');
const { login, enter } = require('../../services/auth');

Page({
  data: { themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : ''), busy: false, identity: null, code: '', message: '' },
  async onShow() { this.setData({ themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : '') });
    if (!wx.getStorageSync('session_token')) return;
    await this.run(async () => this.accept(await request('/me')));
  },
  accept(identity) {
    if (identity.needs_binding) this.setData({ identity, message: '' });
    else enter(identity);
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, message: '' });
    try { await action(); }
    catch (error) {
      this.setData({ message: error.message || '操作失败' });
      if (!wx.getStorageSync('session_token')) this.setData({ identity: null });
    } finally { this.setData({ busy: false }); }
  },
  onCode(event) { this.setData({ code: event.detail.value }); },
  signIn() { this.run(async () => this.accept(await login(() => this.setData({ message: '连接较慢，正在重新尝试登录…' })))); },
  redeem() {
    this.run(async () => this.accept(await request('/invites/redeem', 'POST', { code: this.data.code })));
  },
  copyAccount() {
    if (this.data.identity) wx.setClipboardData({ data: this.data.identity.user.openid });
  }
});
