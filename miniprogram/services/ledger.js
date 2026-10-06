const { request } = require('./api');
async function send(userId, target, action, payload) {
  const storeKey = 'intent:' + userId + ':' + target + ':' + action;
  const fingerprint = JSON.stringify(payload);
  let intent = wx.getStorageSync(storeKey);
  if (!intent || intent.fingerprint !== fingerprint) {
    intent = { fingerprint, id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) };
    wx.setStorageSync(storeKey, intent);
  }
  const path = action === 'reverse' ? '/lesson-records/' + target + '/reverse' : '/packages/' + target + '/' + action;
  const result = await request(path, 'POST', { ...payload, request_id: intent.id });
  wx.removeStorageSync(storeKey);
  return result;
}
module.exports = { send };
