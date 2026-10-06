const { request } = require('../../services/api');
const { enter, handleError } = require('../../services/auth');
const { confirm } = require('../../services/ui');
const { createConsumePanel } = require('../../services/consume-panel');
const consumption = createConsumePanel(async function () {
  await this.load(1); this.setData({ searchInput: '', searchFocus: true });
});
Page({
  ...consumption.methods,
  data: { identity: null, students: [], count: 0, page: 1, hasMore: false, busy: false, message: '', loaded: false, searchInput: '', keyword: '',
    archivingId: '',
    ...consumption.data, searchFocus: false },
  onLoad() { this.requestId = 0; },
  async onShow() {
    clearTimeout(this.searchTimer);
    this.setData({ busy: true });
    try {
      const identity = await request('/me');
      if (identity.role !== 'ORG_ADMIN') { enter(identity); return; }
      this.setData({ identity }); await this.load(1);
    } catch (error) { handleError(this, error); this.setData({ busy: false }); }
  },
  onUnload() { clearTimeout(this.searchTimer); this.requestId++; },
  async load(page, duringArchive = false) {
    if (!this.data.identity || (this.data.archivingId && !duringArchive)) return;
    const keyword = this.data.keyword;
    const requestId = ++this.requestId;
    this.setData({ busy: true, message: '' });
    try {
      const result = await request('/dashboard?page=' + page + '&search=' + encodeURIComponent(keyword));
      if (requestId !== this.requestId || keyword !== this.data.keyword) return;
      const students = result.students.map(item => ({ ...item,
        balanceLabel: !item.package_count ? '暂无可用课时包' : item.total_balance < 0 ? '已透支' : item.total_balance === 0 ? '课时已用完' : item.total_balance <= 3 ? '课时将用完' : '课时充足',
        balanceClass: item.package_count && item.total_balance <= 0 ? 'urgent' : item.total_balance <= 3 ? 'soon' : 'normal' }));
      this.setData({ students: page === 1 ? students : this.data.students.concat(students),
        count: result.count, page, hasMore: result.has_more, loaded: true });
    } catch (error) { if (requestId === this.requestId) handleError(this, error); }
    finally { if (requestId === this.requestId) this.setData({ busy: false }); }
  },
  onSearchInput(e) {
    if (this.data.archivingId) return;
    clearTimeout(this.searchTimer);
    this.requestId++;
    this.setData({ searchInput: e.detail.value, keyword: e.detail.value.trim(), students: [], loaded: false, page: 1, hasMore: false });
    this.searchTimer = setTimeout(() => this.load(1), 350);
  },
  search() { if (this.data.archivingId) return; clearTimeout(this.searchTimer); this.setData({ keyword: this.data.searchInput.trim() }); return this.load(1); },
  clearSearch() { this.onSearchInput({ detail: { value: '' } }); return this.search(); },
  refresh() { return this.load(1); },
  more() { if (!this.data.busy) return this.load(this.data.page + 1); },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.busy) this.more(); },
  open(e) { if (!this.data.archivingId) wx.navigateTo({ url: '/pages/student/index?id=' + e.currentTarget.dataset.id }); },
  withdraw(e) { if (!this.data.busy && !this.data.archivingId && !this.operating && !this.data.consumeOpen) wx.navigateTo({ url: '/pages/withdraw/index?id=' + e.currentTarget.dataset.id }); },
  async archive(e) {
    if (this.data.busy || this.data.archivingId || this.operating || this.data.consumeOpen) return;
    const student = this.data.students.find(item => item.id === e.currentTarget.dataset.id);
    if (!student) return;
    clearTimeout(this.searchTimer);
    this.setData({ archivingId: student.id, message: '' });
    try {
      if (!await confirm('归档学员', '确认归档「' + student.name + '」？\n归档后将从待跟进和正常学员中移除，余额与历史记录保留。可在「学员 → 已归档」中恢复。')) return;
      await request('/students/' + student.id, 'PATCH', { status: 'ARCHIVED' });
      this.setData({ students: this.data.students.filter(item => item.id !== student.id), count: Math.max(0, this.data.count - 1) });
      wx.showToast({ title: '已归档', icon: 'success' });
      await this.load(1, true);
    } catch (error) { handleError(this, error); }
    finally { this.setData({ archivingId: '' }); }
  },
  async moreActions(e) {
    if (this.data.busy || this.data.archivingId || this.operating || this.data.consumeOpen || this.menuOpen) return;
    const student = this.data.students.find(item => item.id === e.currentTarget.dataset.id);
    if (!student) return;
    const choices = student.package_count ? ['充值', '查看课时包与记录', '归档学员（保留课时）', '退学结清（课时清零）']
      : ['查看课时包与记录', '归档学员（保留课时）', '退学结清（课时清零）'];
    this.menuOpen = true;
    const index = await new Promise(resolve => wx.showActionSheet({ itemList: choices, success: result => resolve(result.tapIndex), fail: () => resolve(-1) }));
    this.menuOpen = false;
    if (index < 0) return;
    const selected = choices[index];
    if (selected === '充值') return this.operate({ currentTarget: { dataset: { id: student.id, action: 'recharge' } } });
    if (selected === '查看课时包与记录') return this.open(e);
    if (selected === '归档学员（保留课时）') return this.archive(e);
    if (selected === '退学结清（课时清零）') return this.withdraw(e);
  },
  async operate(e) {
    if (this.operating || this.data.consumeOpen || this.data.archivingId) return;
    const { id, action } = e.currentTarget.dataset;
    if (!['recharge', 'consume'].includes(action)) return;
    this.operating = true;
    wx.showLoading({ title: '正在打开', mask: true });
    try {
      const result = await request('/students/' + id + '/packages');
      const active = result.packages.filter(item => item.status === 'ACTIVE');
      if (action === 'consume') {
        wx.hideLoading();
        await this.openConsumePanel(active, (this.data.students.find(item => item.id === id) || {}).name || '学员', this.data.identity.user.id);
        return;
      }
      const url = active.length === 1
        ? '/pages/package/index?id=' + active[0].id + '&action=' + action
        : '/pages/student/index?id=' + id + '&action=' + action;
      wx.hideLoading();
      await new Promise((resolve, reject) => wx.navigateTo({ url, success: resolve, fail: reject }));
    } catch (error) { wx.hideLoading(); handleError(this, error); }
    finally { this.operating = false; }
  }
});
