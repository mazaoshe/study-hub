const { request } = require('./api');
const { handleError } = require('./auth');
const { confirm } = require('./ui');
const { send } = require('./ledger');
function createConsumePanel(afterSuccess) {
  return {
    data: { consumeOpen: false, consumeBusy: false, consumeMessage: '', consumePackages: [], consumePackageIndex: -1,
      consumePackage: null, consumeCourses: [], consumeCourseIndex: 0, consumeHours: '1', consumeRemark: '' },
    methods: {
      async openConsumePanel(packages, name, userId) {
        if (!packages.length) throw new Error('该学员暂无正常课时包，请先新增课时包');
        this.consumeUserId = userId;
        this.setData({ consumeOpen: true, consumePackages: packages, consumePackageNames: ['请选择课时包'].concat(packages.map(item => item.name)),
          consumePackageIndex: -1, consumePackage: null, consumeStudentName: name,
          consumeCourses: [], consumeHours: '1', consumeRemark: '', consumeMessage: '', searchFocus: false });
        if (packages.length === 1) await this.selectConsumePackage(0);
      },
  async selectConsumePackage(index) {
    if (this.data.consumeBusy) return;
    const selected = this.data.consumePackages[index];
    if (!selected) return;
    this.setData({ consumeBusy: true, consumePackageIndex: index, consumePackage: null, consumeCourses: [], consumeMessage: '' });
    try {
      const result = await request('/packages/' + selected.id);
      if (result.package.status !== 'ACTIVE' || result.package.student_status !== 'ACTIVE') throw new Error('学员或课时包已归档，请刷新后重试');
      const courses = result.package.courses.filter(item => item.status === 'ACTIVE');
      this.setData({ consumePackage: result.package, consumeCourses: courses, consumeCourseIndex: 0,
        consumeMessage: courses.length ? '' : '该课时包暂无正常课程可供消课' });
    } catch (error) { this.consumeError(error); }
    finally { this.setData({ consumeBusy: false }); }
  },
  consumeError(error) { handleError(this, error); this.setData({ consumeMessage: error.message || '操作失败' }); },
  chooseConsumePackage(e) { return this.selectConsumePackage(Number(e.detail.value) - 1); },
  retryConsumePackage() { return this.selectConsumePackage(this.data.consumePackageIndex); },
  chooseConsumeCourse(e) { if (!this.data.consumeBusy) this.setData({ consumeCourseIndex: Number(e.detail.value) }); },
  consumeInput(e) { if (!this.data.consumeBusy) this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  quickConsumeHours(e) { if (!this.data.consumeBusy) this.setData({ consumeHours: String(e.currentTarget.dataset.hours) }); },
  closeConsume() { if (!this.data.consumeBusy) this.setData({ consumeOpen: false }); },
  stopTouch() {},
  async submitConsume() {
    if (this.data.consumeBusy) return;
    const pack = this.data.consumePackage, course = this.data.consumeCourses[this.data.consumeCourseIndex];
    const hours = Number(this.data.consumeHours);
    if (!pack || !course || !Number.isSafeInteger(hours) || hours <= 0) {
      this.setData({ consumeMessage: '请选择课时包、课程并填写正整数课时' }); return;
    }
    this.setData({ consumeBusy: true, consumeMessage: '' });
    try {
      const remaining = pack.paid_balance + pack.gift_balance - hours;
      if (!await confirm('确认消课', pack.student_name + ' · ' + course.name + '\n扣除 ' + hours + ' 课时，剩余 ' + remaining + ' 课时' +
        (remaining < 0 ? '\n本次操作后将透支 ' + (-remaining) + ' 课时' : ''))) return;
      await send(this.consumeUserId, pack.id, 'consume', { hours, course_id: course.id, remark: this.data.consumeRemark });
      this.setData({ consumeOpen: false });
      wx.showToast({ title: '消课成功', icon: 'success' });
      await afterSuccess.call(this);
    } catch (error) { this.consumeError(error); }
    finally { this.setData({ consumeBusy: false }); }
  }
    }
  };
}
module.exports = { createConsumePanel };
