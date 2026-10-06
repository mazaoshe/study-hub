const { request } = require('../../services/api');
const { run, allCourses } = require('../../services/ui');
Page({
  data: { student: null, packages: [], visiblePackages: [], packageStatus: 'ACTIVE', activeCount: 0, archivedCount: 0, loaded: false, courses: [], selected: [], creating: false, busy: false, message: '', actionLabel: '' },
  onLoad(options) {
    this.id = options.id;
    this.initialCreate = options.create === '1';
    this.action = ['recharge', 'consume'].includes(options.action) ? options.action : '';
    this.setData({ actionLabel: this.action === 'recharge' ? '充值' : this.action === 'consume' ? '消课' : '' });
  },
  onShow() { return run(this, async () => {
    await this.load();
    if ((this.initialCreate || this.data.creating) && this.data.student.status === 'ACTIVE') {
      const courses = await allCourses();
      const selected = this.initialCreate ? [] : this.data.selected.filter(id => courses.some(course => course.id === id));
      this.setData({ courses: courses.map(course => ({ ...course, checked: selected.includes(course.id) })), selected, creating: true });
      this.initialCreate = false;
    }
  }); },
  async load() {
    const student = await request('/students/' + this.id);
    const packages = await request('/students/' + this.id + '/packages');
    this.setData({ student: student.item, packages: packages.packages, loaded: true,
      activeCount: packages.packages.filter(p => p.status === 'ACTIVE').length,
      archivedCount: packages.packages.filter(p => p.status === 'ARCHIVED').length });
    this.filterPackages();
    if (this.action && student.item.status === 'ACTIVE') {
      const active = packages.packages.filter(p => p.status === 'ACTIVE');
      if (!active.length) this.setData({ message: '请先创建或恢复该学员的课时包' });
    }
  },
  filterPackages() { this.setData({ visiblePackages: this.data.packages.filter(p => p.status === this.data.packageStatus) }); },
  switchPackages(e) {
    const status = e.currentTarget.dataset.status;
    if (this.data.busy || !['ACTIVE', 'ARCHIVED'].includes(status)) return;
    this.setData({ packageStatus: status }); this.filterPackages();
  },
  create() { if (!this.data.student || this.data.student.status !== 'ACTIVE') return; return run(this, async () => { this.setData({ courses: await allCourses(), selected: [], creating: true }); }); },
  select(e) { this.setData({ selected: e.detail.value }); },
  cancel() { this.setData({ creating: false }); },
  save() { run(this, async () => {
    const result = await request('/students/' + this.id + '/packages', 'POST', { course_ids: this.data.selected });
    this.setData({ creating: false, packageStatus: 'ACTIVE' }); wx.navigateTo({ url: '/pages/package/index?id=' + result.package.id });
  }); },
  open(e) {
    if (this.data.busy) return;
    const item = this.data.packages.find(p => p.id === e.currentTarget.dataset.id);
    const action = this.action && item && item.status === 'ACTIVE' && this.data.student.status === 'ACTIVE' ? '&action=' + this.action : '';
    wx.navigateTo({ url: '/pages/package/index?id=' + e.currentTarget.dataset.id + action });
  },
  withdraw() { if (!this.data.busy) wx.navigateTo({ url: '/pages/withdraw/index?id=' + this.id }); },
  courses() { wx.navigateTo({ url: '/pages/catalog/index?kind=courses' }); }
});
