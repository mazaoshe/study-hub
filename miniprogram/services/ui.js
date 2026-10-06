const { request } = require('./api');
const { handleError } = require('./auth');
async function run(page, action) {
  if (page.data.busy) return;
  page.setData({ busy: true, message: '' });
  try { await action(); } catch (error) { handleError(page, error); }
  finally { page.setData({ busy: false }); }
}
function confirm(title, content) {
  return new Promise(resolve => wx.showModal({ title, content, success: r => resolve(r.confirm), fail: () => resolve(false) }));
}
async function allCourses() {
  let page = 1, items = [], result;
  do { result = await request('/courses?page=' + page++); items = items.concat(result.items); } while (result.has_more);
  return items;
}
function recordViews(items) {
  const formatTime = value => { const d = new Date(value), pad = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const names = { RECHARGE: '充值', CONSUME: '消课', REVERSAL: '冲正', WITHDRAWAL: '退学结清' };
  return items.map(item => ({ ...item, typeName: names[item.type], time: formatTime(item.created_at),
    paidText: (item.paid_change > 0 ? '+' : '') + item.paid_change,
    giftText: (item.gift_change > 0 ? '+' : '') + item.gift_change }));
}
module.exports = { run, confirm, allCourses, recordViews };
