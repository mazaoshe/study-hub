const { request } = require('../../services/api');
const { enter, handleError } = require('../../services/auth');

Page({
  data: { themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : ''), organizations: [], page: 1, hasMore: false, name: '', busy: false, message: '', inviteCode: '', inviteOrg: '', inviteOrgId: '' },
  onShow() { this.setData({ themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : '') });
    this.run(async () => {
      const identity = await request('/me');
      if (identity.role !== 'SUPER_ADMIN') { enter(identity); return; }
      await this.load(1);
    });
  },
  async load(page) {
    const result = await request('/organizations?page=' + page);
    this.setData({ organizations: page === 1 ? result.organizations : this.data.organizations.concat(result.organizations),
      page, hasMore: result.has_more });
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, message: '' });
    try { await action(); }
    catch (error) { handleError(this, error); }
    finally { this.setData({ busy: false }); }
  },
  onName(event) { this.setData({ name: event.detail.value }); },
  create() {
    this.run(async () => {
      await request('/organizations', 'POST', { name: this.data.name });
      this.setData({ name: '' });
      await this.load(1);
    });
  },
  loadMore() { this.run(() => this.load(this.data.page + 1)); },
  invite(event) {
    const org = this.data.organizations.find(item => item.id === event.currentTarget.dataset.id);
    if (!org) return;
    this.run(async () => {
      const result = await request('/invites', 'POST', { organization_id: org.id });
      this.setData({ inviteCode: result.code, inviteOrg: org.name, inviteOrgId: org.id });
    });
  },
  copyInvite() { wx.setClipboardData({ data: this.data.inviteCode }); },
  rename(event) {
    const org = this.data.organizations.find(item => item.id === event.currentTarget.dataset.id);
    if (!org || this.data.busy) return;
    wx.showModal({ title: '修改机构名称', editable: true, placeholderText: org.name,
      success: result => {
        if (!result.confirm) return;
        this.run(async () => {
          await request('/organizations/' + org.id, 'PATCH', { name: result.content });
          await this.load(1);
        });
      }
    });
  },
  toggle(event) {
    const org = this.data.organizations.find(item => item.id === event.currentTarget.dataset.id);
    if (!org || this.data.busy) return;
    const disabled = org.status === 'ACTIVE';
    wx.showModal({ title: disabled ? '停用机构' : '启用机构',
      content: disabled ? '停用后，该机构所有管理员将立即无法访问，是否继续？' : '启用后，该机构管理员可以重新访问。',
      success: result => {
        if (!result.confirm) return;
        this.run(async () => {
          await request('/organizations/' + org.id, 'PATCH', { status: disabled ? 'DISABLED' : 'ACTIVE' });
          if (disabled && this.data.inviteOrgId === org.id) this.setData({ inviteCode: '', inviteOrg: '', inviteOrgId: '' });
          await this.load(1);
        });
      }
    });
  },
  logout() {
    this.run(async () => {
      await request('/auth/logout', 'POST', {});
      wx.removeStorageSync('session_token');
      wx.reLaunch({ url: '/pages/login/index' });
    });
  }
});
