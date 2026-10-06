import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { sessionHash } from '../lib/tokens';
import { IdentityRepository } from '../repositories/identity';
import { activeIdentity } from '../services/identity';

export const authenticated = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const match = /^Bearer ([0-9a-f]{64})$/.exec(header);
  if (!match) throw new ApiError(401, 'UNAUTHORIZED', '请先登录');
  const digest = await sessionHash(match[1], c.env.SESSION_SECRET);
  const user = await new IdentityRepository(c.env.DB).bySession(digest, Math.floor(Date.now() / 1000));
  if (!user) throw new ApiError(401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  c.set('identity', activeIdentity(user, c.env));
  c.set('sessionHash', digest);
  c.header('Cache-Control', 'no-store');
  await next();
});

export const superAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('identity').role !== 'SUPER_ADMIN') throw new ApiError(403, 'FORBIDDEN', '仅超级管理员可操作');
  await next();
});

export const orgAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get('identity');
  if (user.role !== 'ORG_ADMIN' || !user.organization_id) throw new ApiError(403, 'FORBIDDEN', '仅机构管理员可操作');
  await next();
});
