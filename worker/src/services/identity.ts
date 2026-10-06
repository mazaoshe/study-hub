import type { Bindings, Identity } from '../domain/types';
import { ApiError } from '../lib/errors';
import { randomToken, sessionHash } from '../lib/tokens';
import { IdentityRepository } from '../repositories/identity';

export function activeIdentity(user: Identity, env: Bindings): Identity {
  if (user.status !== 'ACTIVE') throw new ApiError(403, 'USER_DISABLED', '账号已停用');
  // Read the current configured owner on every request so changing it revokes old super privileges.
  const role = env.SUPER_ADMIN_OPENID && user.openid === env.SUPER_ADMIN_OPENID
    ? 'SUPER_ADMIN' : user.organization_id ? 'ORG_ADMIN' : null;
  if (role !== 'SUPER_ADMIN' && user.organization_id && user.organization_status !== 'ACTIVE') {
    throw new ApiError(403, 'ORGANIZATION_DISABLED', '机构已停用，请联系管理员');
  }
  return { ...user, role };
}

export function publicIdentity(user: Identity) {
  return {
    user: { id: user.id, openid: user.openid, status: user.status },
    role: user.role,
    organization: user.role === 'SUPER_ADMIN' || !user.organization_id ? null : {
      id: user.organization_id, name: user.organization_name, status: user.organization_status
    },
    needs_binding: user.role === null
  };
}

export async function login(code: string, env: Bindings) {
  const token = randomToken();
  const tokenHash = await sessionHash(token, env.SESSION_SECRET);
  if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '登录服务尚未配置，请联系管理员');
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: env.WECHAT_APP_ID, secret: env.WECHAT_APP_SECRET,
    js_code: code, grant_type: 'authorization_code' }).toString();
  let response: Response;
  let result: { openid?: string; errcode?: number };
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    result = await response.json();
  } catch {
    throw new ApiError(502, 'WECHAT_UNAVAILABLE', '微信登录暂时不可用，请稍后重试');
  }
  if (!response.ok) throw new ApiError(502, 'WECHAT_UNAVAILABLE', '微信登录暂时不可用，请稍后重试');
  if (result.errcode === 40029 || result.errcode === 40163) {
    throw new ApiError(400, 'WECHAT_CODE_INVALID', '登录凭证已失效，请重新登录');
  }
  if (result.errcode || typeof result.openid !== 'string' || !result.openid) {
    throw new ApiError(502, 'WECHAT_LOGIN_FAILED', '微信登录失败，请检查后台登录配置');
  }
  const repository = new IdentityRepository(env.DB);
  const now = new Date().toISOString();
  const user = activeIdentity(await repository.upsert(result.openid, result.openid === env.SUPER_ADMIN_OPENID, now), env);
  const expires = Math.floor(Date.now() / 1000) + 7 * 86400;
  await repository.saveSession(tokenHash, user.id, expires, now);
  return { token, expires_at: expires, ...publicIdentity(user) };
}
