const { request } = require('../../services/api');
const { run, recordViews } = require('../../services/ui');
Page({
  data: { items: [], page: 1, hasMore: false, busy: false, message: '', legacy: false },
  onLoad(options) { this.packageId = options.package_id || ''; this.setData({ legacy: options.kind === 'legacy' }); },
  onShow() { run(this, () => this.load(1)); },
  async load(page) {
    const result = await request((this.data.legacy ? '/legacy-records' : '/lesson-records') + '?page=' + page + (this.packageId ? '&package_id=' + encodeURIComponent(this.packageId) : ''));
    const items = this.data.legacy ? result.items.map(item => ({ ...item,
      typeName: item.action === 'add' ? '增加' : '扣除',
      hoursText: (item.action === 'add' ? '+' : '-') + item.hours,
      time: (item.source_created_at || '').replace('T', ' ').slice(0, 19),
      useDate: item.use_date ? item.use_date.slice(0, 10) : ''
    })) : recordViews(result.items);
    this.setData({ items: page === 1 ? items : this.data.items.concat(items), page, hasMore: result.has_more });
  },
  switchKind() { return run(this, async () => { this.setData({ legacy: !this.data.legacy, items: [], hasMore: false }); await this.load(1); }); },
  more() { run(this, () => this.load(this.data.page + 1)); },
  open(e) { const { id, student } = e.currentTarget.dataset; wx.navigateTo({ url: id ? '/pages/package/index?id=' + id : '/pages/student/index?id=' + student }); }
});
