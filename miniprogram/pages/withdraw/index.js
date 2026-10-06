const { request } = require('../../services/api');
const { run, confirm } = require('../../services/ui');
const withdrawal = require('../../services/withdrawal');
Page({
  data: { preview: null, confirmed: false, remark: '', busy: false, message: '', retrying: false, done: false },
  onLoad(options) { this.id = options.id; },
  onShow() { if (!this.data.done) return run(this, () => this.load()); },
  async load() {
    const identity = await request('/me'); this.userId = identity.user.id;
    const intent = withdrawal.pending(this.userId, this.id);
    if (intent) {
      this.setData({ preview: intent.preview, remark: intent.payload.remark, confirmed: false, retrying: true });
    } else {
      const preview = await request('/students/' + this.id + '/withdrawal-preview');
      this.setData({ preview, confirmed: false, retrying: false });
    }
  },
  acknowledge(e) { if (!this.data.busy) this.setData({ confirmed: e.detail.value.includes('confirmed') }); },
  input(e) { if (!this.data.busy && !this.data.retrying) this.setData({ remark: e.detail.value }); },
  reload() { if (!this.data.retrying) return run(this, () => this.load()); },
  submit() { return run(this, async () => {
    if (this.data.done || !this.data.preview || this.data.preview.blocked_reason) return;
    if (!this.data.confirmed) { this.setData({ message: '请先确认已完成线下退费' }); return; }
    if (!await confirm('确认退学结清', this.data.preview.student.name + '\n全部未结清课时包的付费和赠送余额将清零，学员归档。结清后不能恢复这些课时包或冲正其中的流水；重新报名需新建课时包。')) return;
    try {
      await withdrawal.submit(this.userId, this.id, this.data.preview, this.data.remark);
      this.setData({ done: true, confirmed: false, retrying: false });
      wx.showToast({ title: '已退学结清', icon: 'success' });
    } catch (error) {
      this.setData({ retrying: !!withdrawal.pending(this.userId, this.id) });
      if (!this.data.retrying) this.setData({ preview: { ...this.data.preview, blocked_reason: error.message + '，请重新核对' }, confirmed: false });
      throw error;
    }
  }); },
  back() { wx.navigateBack(); }
});
