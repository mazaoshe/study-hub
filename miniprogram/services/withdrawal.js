const { request } = require('./api');
const key = (userId, studentId) => 'withdrawal:' + userId + ':' + studentId;
function pending(userId, studentId) { return wx.getStorageSync(key(userId, studentId)) || null; }
async function submit(userId, studentId, preview, remark) {
  const storeKey = key(userId, studentId);
  let intent = pending(userId, studentId);
  if (!intent) {
    intent = { preview, payload: { expected_snapshot: preview.snapshot, refund_confirmed: true, remark,
      request_id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) } };
    wx.setStorageSync(storeKey, intent);
  }
  try {
    const result = await request('/students/' + studentId + '/withdraw', 'POST', intent.payload);
    wx.removeStorageSync(storeKey); return result;
  } catch (error) {
    // These responses definitively reject the transaction; network/500 errors do not.
    if (['WITHDRAWAL_BALANCE_CHANGED', 'WITHDRAWAL_OVERDRAFT', 'WITHDRAWAL_UNAVAILABLE', 'REFUND_NOT_CONFIRMED', 'INVALID_INPUT', 'PAYLOAD_TOO_LARGE'].includes(error.code)) {
      wx.removeStorageSync(storeKey);
    }
    throw error;
  }
}
module.exports = { pending, submit };
