const { request } = require('../../services/api');

Page({
  data: { themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : ''), content: '课时工具连接测试', busy: false, message: '等待测试', entries: [] },
  onInput(event) { this.setData({ content: event.detail.value }); },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true, message: '正在连接…' });
    try { await action(); }
    catch (error) { this.setData({ message: error.message || '操作失败' }); }
    finally { this.setData({ busy: false }); }
  },
  testConnection() {
    this.run(async () => {
      const result = await request('/health');
      if (!result || result.ok !== true) throw new Error('服务返回异常');
      this.setData({ message: '连接成功' });
    });
  },
  writeEntry() {
    const content = this.data.content.trim();
    if (!content) { this.setData({ message: '请先输入测试内容' }); return; }
    this.run(async () => {
      const result = await request('/test', 'POST', { content });
      this.setData({ message: '写入成功，记录编号：' + result.entry.id });
    });
  },
  readEntries() {
    this.run(async () => {
      const result = await request('/test');
      this.setData({ entries: result.entries, message: '读取成功，共 ' + result.entries.length + ' 条' });
    });
  }
});
