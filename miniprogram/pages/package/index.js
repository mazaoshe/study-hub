const { send } = require('../../services/ledger');
const { request } = require('../../services/api');
const { run, confirm, allCourses, recordViews } = require('../../services/ui');
Page({
  data: { themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : ''), package: null, records: [], hasMore: false, page: 1, mode: '', paid: '', gift: '', hours: '', remark: '',
    courseIndex: 0, activeCourses: [], editCourses: [], selected: [], name: '', busy: false, message: '' },
  onLoad(options) { this.id = options.id; this.initialAction = ['recharge', 'consume'].includes(options.action) ? options.action : ''; },
  onShow() { this.setData({ themeClass: (typeof wx.getStorageSync === 'function' && wx.getStorageSync('theme') === 'classic' ? 'theme-classic' : '') }); run(this, async () => {
    const me = await request('/me'); this.userId = me.user.id; await this.load();
    if (this.initialAction && this.data.package.status === 'ACTIVE' && this.data.package.student_status === 'ACTIVE') {
      if (this.initialAction === 'consume' && !this.data.activeCourses.length) this.setData({ message: '该课时包暂无正常课程可供消课' });
      else this.mode({ currentTarget: { dataset: { mode: this.initialAction } } });
      this.initialAction = '';
    }
  }); },
  async load() {
    const result = await request('/packages/' + this.id);
    this.setData({ package: result.package, activeCourses: result.package.courses.filter(c => c.status === 'ACTIVE'), courseIndex: 0 });
    await this.records(1);
  },
  async records(page) {
    const result = await request('/lesson-records?package_id=' + this.id + '&page=' + page);
    this.setData({ records: page === 1 ? recordViews(result.items) : this.data.records.concat(recordViews(result.items)), page, hasMore: result.has_more });
  },
  more() { run(this, () => this.records(this.data.page + 1)); },
  history() { wx.navigateTo({ url: '/pages/records/index?kind=legacy&package_id=' + encodeURIComponent(this.id) }); },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  course(e) { this.setData({ courseIndex: Number(e.detail.value) }); },
  select(e) { this.setData({ selected: e.detail.value }); },
  mode(e) { this.setData({ mode: e.currentTarget.dataset.mode, paid: '', gift: '', hours: e.currentTarget.dataset.mode === 'consume' ? '1' : '', remark: '' }); },
  quickHours(e) { if (!this.data.busy) this.setData({ hours: String(e.currentTarget.dataset.hours) }); },
  cancel() { this.setData({ mode: '' }); },
  async send(action, payload, target = this.id) {
    return send(this.userId, target, action, payload);
  },
  submit() { return run(this, async () => {
    const remark = this.data.remark;
    const pack = this.data.package;
    if (!pack || pack.status !== 'ACTIVE' || pack.student_status !== 'ACTIVE' || !['recharge', 'consume'].includes(this.data.mode)) throw new Error('请先选择正常课时包的充值或消课操作');
    if (this.data.mode === 'recharge') {
      const paid = this.data.paid === '' ? 0 : Number(this.data.paid), gift = this.data.gift === '' ? 0 : Number(this.data.gift);
      if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(gift) || paid < 0 || gift < 0 || !Number.isSafeInteger(paid + gift) || paid + gift <= 0) throw new Error('请输入非负整数，总充值课时须大于零');
      const remaining = pack.paid_balance + pack.gift_balance + paid + gift;
      if (!await confirm('确认充值', pack.student_name + ' · ' + pack.name + '\n付费增加 ' + paid + ' 课时，赠送增加 ' + gift + ' 课时\n充值后共 ' + remaining + ' 课时' + (remaining < 0 ? '\n仍透支 ' + (-remaining) + ' 课时' : ''))) return;
      await this.send('recharge', { paid_hours: paid, gift_hours: gift, remark });
    } else {
      const hours = Number(this.data.hours), course = this.data.activeCourses[this.data.courseIndex];
      if (!Number.isSafeInteger(hours) || hours <= 0 || !course) throw new Error('请选择课程并填写正整数课时');
      const remaining = pack.paid_balance + pack.gift_balance - hours;
      if (!await confirm('确认消课', pack.student_name + ' · ' + course.name + '\n扣除 ' + hours + ' 课时，优先扣赠送\n消课后共 ' + remaining + ' 课时' + (remaining < 0 ? '\n将透支 ' + (-remaining) + ' 课时' : ''))) return;
      await this.send('consume', { hours, course_id: course.id, remark });
    }
    this.setData({ mode: '', paid: '', gift: '', hours: '', remark: '' });
    wx.showToast({ title: '已记录', icon: 'success' }); await this.load();
  }); },
  reverse(e) {
    const record = this.data.records.find(r => r.id === e.currentTarget.dataset.id);
    if (!record || record.reversed || record.settled || !['RECHARGE', 'CONSUME'].includes(record.type)) return;
    run(this, async () => {
      if (!await confirm('冲正流水', '撤销这笔' + record.typeName + '的课时变动，原流水会保留。')) return;
      if (!this.data.reverseReason || this.reverseTarget !== record.id) {
        const reason = await new Promise(resolve => wx.showModal({ title: '冲正原因', editable: true, placeholderText: '填写原因（必填）', success: r => resolve(r.confirm ? r.content : null), fail: () => resolve(null) }));
        if (reason === null) return;
        if (!reason.trim()) throw new Error('请填写冲正原因');
        this.reverseTarget = record.id; this.setData({ reverseReason: reason.trim() });
      }
      await this.send('reverse', { remark: this.data.reverseReason }, record.id);
      this.setData({ reverseReason: '' }); await this.load();
    });
  },
  edit() { run(this, async () => {
    const courses = await allCourses(), ids = this.data.package.courses.map(c => c.id);
    this.setData({ mode: 'edit', name: this.data.package.name, selected: courses.filter(c => ids.includes(c.id)).map(c => c.id), editCourses: courses.map(c => ({ ...c, checked: ids.includes(c.id) })) });
  }); },
  save() { run(this, async () => {
    const before = this.data.package.courses.filter(c => c.status === 'ACTIVE').map(c => c.id).sort().join(',');
    const after = this.data.selected.slice().sort().join(',');
    await request('/packages/' + this.id, 'PATCH', { name: this.data.name, ...(before === after ? {} : { course_ids: this.data.selected }) });
    this.setData({ mode: '' }); await this.load();
  }); },
  toggle() { run(this, async () => {
    const archived = this.data.package.status === 'ACTIVE';
    if (!await confirm(archived ? '归档课时包' : '恢复课时包', '历史流水和余额会保留。')) return;
    await request('/packages/' + this.id, 'PATCH', { status: archived ? 'ARCHIVED' : 'ACTIVE' }); await this.load();
  }); }
});
