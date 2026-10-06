const { request } = require('../../services/api');
const { enter, handleError } = require('../../services/auth');

Page({
  data: { identity: null, admins: [], busy: false, message: '', inviteCode: '', exportPath: '', exportName: '' },
  onShow() {
    this.run(async () => {
      const identity = await request('/me');
      if (identity.role !== 'ORG_ADMIN') { enter(identity); return; }
      const result = await request('/admins');
      this.setData({ identity, admins: result.admins });
    });
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, message: '' });
    try { await action(); }
    catch (error) { handleError(this, error); }
    finally { this.setData({ busy: false }); }
  },
  invite() {
    this.run(async () => {
      const result = await request('/invites', 'POST', {});
      this.setData({ inviteCode: result.code });
    });
  },
  copyInvite() { wx.setClipboardData({ data: this.data.inviteCode }); },
  courses() { wx.navigateTo({ url: '/pages/catalog/index?kind=courses' }); },
  records() { wx.navigateTo({ url: '/pages/records/index' }); },
  exportData(event) {
    const kind = event.currentTarget.dataset.kind;
    const names = { students: '学员', packages: '课时包', records: '课时流水', 'legacy-records': '历史记录' };
    if (!names[kind]) return;
    this.run(async () => {
      const content = await request('/exports/' + kind, 'GET', undefined, { timeout: 60000, dataType: 'text' });
      const name = names[kind] + '-' + new Date().toISOString().slice(0, 10) + '.csv';
      const filePath = wx.env.USER_DATA_PATH + '/' + name;
      await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: content, encoding: 'utf8', success: resolve, fail: () => reject(new Error('导出文件保存失败')) }));
      this.setData({ exportPath: filePath, exportName: name, message: '导出完成，点击分享文件保存或发送' });
    });
  },
  shareExport() {
    if (!wx.shareFileMessage) { this.setData({ message: '请更新微信后使用文件分享' }); return; }
    wx.shareFileMessage({ filePath: this.data.exportPath, fileName: this.data.exportName,
      fail: error => { if (!error.errMsg || !error.errMsg.includes('cancel')) this.setData({ message: '分享未成功，可点击分享文件重试' }); } });
  },
  logout() {
    this.run(async () => {
      await request('/auth/logout', 'POST', {});
      wx.removeStorageSync('session_token');
      wx.reLaunch({ url: '/pages/login/index' });
    });
  }
});
