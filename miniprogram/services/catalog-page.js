const { request } = require('./api');
const { run, confirm } = require('./ui');
const { createConsumePanel } = require('./consume-panel');
function localDate(value) {
  if (!value) return '';
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  return Number.isNaN(date.getTime()) ? '' : date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
function createCatalogPage(fixedKind) {
const consumption = createConsumePanel(async function () {
  await run(this, async () => { await this.refresh(); this.setData({ searchInput: '', searchFocus: true }); });
});
return {
  ...consumption.methods,
  data: { ...consumption.data, searchFocus: false, kind: 'students', title: '学员', items: [], searchInput: '', search: '', archived: false, page: 1, hasMore: false, total: null, loaded: false,
    sortIndex: 0, sortLabels: ['姓名 A–Z', '剩余课时从少到多', '最近新增'],
    editing: false, editId: '', name: '', phone: '', remark: '', remarkLimit: 500, busy: false, message: '' },
  onLoad(options = {}) { const kind = fixedKind || (options.kind === 'courses' ? 'courses' : 'students'); this.setData({ kind, title: kind === 'courses' ? '课程' : '学员', archived: false }); },
  onShow() { return run(this, () => this.data.loaded ? this.refresh() : this.load(1)); },
  onPageScroll(e) { this.scrollTop = e.scrollTop; },
  async fetchPage(page) {
    const filter = this.data.kind === 'students' ? '&sort=' + (this.data.archived ? 'archived' : ['name', 'balance', 'newest'][this.data.sortIndex]) + '&status=' + (this.data.archived ? 'ARCHIVED' : 'ACTIVE') : '&archived=' + (this.data.archived ? 1 : 0);
    const result = await request('/' + this.data.kind + '?page=' + page + '&search=' + encodeURIComponent(this.data.search) + filter);
    const items = result.items.map(item => ({ ...item,
      archivedDate: localDate(item.archived_at),
      displayRemark: this.data.kind === 'students' ? (item.remark || '').replace(/^\s*StudyHub\s+旧学员编号\s+\S+\s*$/gm, '').trim() : item.remark,
      balanceClass: item.total_balance < 0 ? 'negative' : item.package_count && item.total_balance <= 3 ? 'low-balance' : '' }));
    return { items, page, hasMore: result.has_more, total: Number.isSafeInteger(result.total) ? result.total : null, loaded: true };
  },
  async load(page) {
    const result = await this.fetchPage(page);
    this.setData({ ...result, items: page === 1 ? result.items : this.data.items.concat(result.items) });
  },
  async refresh() {
    const lastPage = this.data.page, scrollTop = this.scrollTop || 0;
    let result, items = [];
    for (let page = 1; page <= lastPage; page++) {
      result = await this.fetchPage(page); items = items.concat(result.items);
      if (!result.hasMore) break;
    }
    // Publish once: keep the existing list and its scroll position while refreshing.
    this.setData({ ...result, items }, () => { if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop, duration: 0 }); });
  },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  search() { return run(this, async () => { this.setData({ search: this.data.searchInput.trim(), items: [], page: 1, total: null, loaded: false, hasMore: false }); await this.load(1); }); },
  more() { if (!this.data.editing && this.data.hasMore) return run(this, () => this.load(this.data.page + 1)); },
  onReachBottom() { return this.more(); },
  archived(e) { if (!this.data.busy) { this.setData({ archived: e.detail.value }); return this.search(); } },
  sort(e) {
    const sortIndex = Number(e.detail.value);
    if (this.data.busy || !Number.isInteger(sortIndex) || sortIndex < 0 || sortIndex > 2 || sortIndex === this.data.sortIndex) return;
    this.setData({ sortIndex }); return this.search();
  },
  selectStatus(e) {
    const archived = e.currentTarget.dataset.status === 'ARCHIVED';
    if (this.data.busy || archived === this.data.archived) return;
    this.setData({ archived, editing: false }); return this.search();
  },
  create() { if (!this.data.busy) this.setData({ editing: true, editId: '', name: '', phone: '', remark: '', remarkLimit: 500, message: '' }); },
  edit(e) {
    if (this.data.busy) return;
    const item = this.data.items.find(x => x.id === e.currentTarget.dataset.id); if (!item) return;
    const notes = this.remarkParts(item.remark);
    this.setData({ editing: true, editId: item.id, name: item.name, phone: item.phone || '', remark: notes.visible,
      remarkLimit: 500 - (notes.metadata ? notes.metadata.length + 1 : 0), message: '' });
  },
  remarkParts(remark = '') {
    const pattern = /^\s*StudyHub\s+旧学员编号\s+\S+\s*$/gm;
    return this.data.kind === 'students' ? { visible: remark.replace(pattern, '').trim(), metadata: (remark.match(pattern) || []).map(line => line.trim()).join('\n') }
      : { visible: remark, metadata: '' };
  },
  cancel() { if (!this.data.busy) this.setData({ editing: false, message: '' }); },
  stopTouch() {},
  save() { return run(this, async () => {
    const newStudent = this.data.kind === 'students' && !this.data.editId;
    const original = this.data.items.find(item => item.id === this.data.editId);
    const notes = this.remarkParts(original ? original.remark : '');
    const remark = original && notes.visible === this.data.remark ? original.remark
      : [notes.metadata, this.data.remark].filter(Boolean).join('\n');
    const result = await request('/' + this.data.kind + (this.data.editId ? '/' + this.data.editId : ''), this.data.editId ? 'PATCH' : 'POST',
      { name: this.data.name, phone: this.data.phone, remark });
    this.setData({ editing: false });
    if (newStudent) {
      wx.navigateTo({ url: '/pages/student/index?id=' + result.item.id + '&create=1' });
    } else await this.refresh();
  }); },
  toggle(e) { const item = this.data.items.find(x => x.id === e.currentTarget.dataset.id); if (!item) return;
    return run(this, async () => {
      const archive = item.status === 'ACTIVE';
      if (!await confirm(archive ? '归档' + this.data.title : '恢复' + this.data.title, archive ? '归档后停止新增业务，已有课时和流水会保留。' : '恢复后可继续使用。')) return;
      await request('/' + this.data.kind + '/' + item.id, 'PATCH', { status: archive ? 'ARCHIVED' : 'ACTIVE' }); await this.refresh();
    });
  },
  async moreActions(e) {
    if (this.data.busy || this.data.editing || this.menuOpen) return;
    const item = this.data.items.find(x => x.id === e.currentTarget.dataset.id); if (!item) return;
    this.menuOpen = true;
    const index = await new Promise(resolve => wx.showActionSheet({
      itemList: ['编辑资料', item.status === 'ACTIVE' ? '归档学员（保留课时）' : '恢复学员', '退学结清（课时清零）', ...(item.status === 'ACTIVE' && item.package_count ? ['充值'] : [])],
      success: result => resolve(result.tapIndex), fail: () => resolve(-1)
    }));
    this.menuOpen = false;
    if (index === 0) this.edit(e);
    if (index === 1) return this.toggle(e);
    if (index === 2) wx.navigateTo({ url: '/pages/withdraw/index?id=' + item.id });
    if (index === 3) return this.operate({ currentTarget: { dataset: { id: item.id, action: 'recharge' } } });
  },
  operate(e) {
    const { id, action } = e.currentTarget.dataset;
    const item = this.data.items.find(x => x.id === id);
    if (this.data.consumeOpen || !item || item.status !== 'ACTIVE' || !['consume', 'recharge'].includes(action)) return;
    return run(this, async () => {
      const result = await request('/students/' + id + '/packages');
      const active = result.packages.filter(pack => pack.status === 'ACTIVE');
      if (action === 'consume') {
        if (!active.length) throw new Error('该学员暂无正常课时包，请先新增课时包');
        const identity = await request('/me');
        await this.openConsumePanel(active, item.name, identity.user.id);
        return;
      }
      const url = active.length === 1 ? '/pages/package/index?id=' + active[0].id + '&action=' + action
        : '/pages/student/index?id=' + id + '&action=' + action;
      await new Promise((resolve, reject) => wx.navigateTo({ url, success: resolve, fail: () => reject(new Error('页面未能打开，请重试')) }));
    });
  },
  addPackage(e) { if (!this.data.busy) wx.navigateTo({ url: '/pages/student/index?id=' + e.currentTarget.dataset.id + '&create=1' }); },
  detail(e) { if (!this.data.busy && this.data.kind === 'students') wx.navigateTo({ url: '/pages/student/index?id=' + e.currentTarget.dataset.id }); }
}; }
module.exports = { createCatalogPage };
