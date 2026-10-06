const { API_BASE_URL } = require('../config');

function request(path, method = 'GET', data, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE_URL.replace(/\/$/, '') + path,
      method,
      data,
      timeout: options.timeout || 15000,
      ...(options.responseType ? { responseType: options.responseType } : {}),
      ...(options.dataType ? { dataType: options.dataType } : {}),
      header: {
        'content-type': 'application/json',
        ...(wx.getStorageSync('session_token') ? { Authorization: 'Bearer ' + wx.getStorageSync('session_token') } : {})
      },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(response.data);
        } else {
          if (typeof response.data === 'string') { try { response.data = JSON.parse(response.data); } catch (_) {} }
          const error = new Error((response.data && response.data.message) || '请求失败');
          error.status = response.statusCode;
          error.code = response.data && response.data.error;
          if (error.status === 401 || error.code === 'USER_DISABLED' || error.code === 'ORGANIZATION_DISABLED') {
            wx.removeStorageSync('session_token');
          }
          reject(error);
        }
      },
      fail(result) {
        const timeout = result && /timeout/i.test(result.errMsg || '');
        const error = new Error(timeout ? '请求超时，请切换 Wi-Fi 或移动网络后重试' : '网络连接失败，请检查网络后重试');
        error.code = timeout ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR';
        reject(error);
      }
    });
  });
}
module.exports = { request };
