import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { body, text } from '../lib/input';
import { hash } from '../lib/tokens';
import { authenticated, superAdmin } from '../middleware/auth';
import { IdentityRepository } from '../repositories/identity';
import { TenantRepository } from '../repositories/tenant';
import { activeIdentity, publicIdentity } from '../services/identity';
import { createInvite } from '../services/tenant';

export const tenantRoutes = new Hono<AppEnv>();
tenantRoutes.get('/organizations', authenticated, superAdmin, async (c) => {
  const page = Number(c.req.query('page') || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ApiError(400, 'INVALID_INPUT', '页码错误');
  const rows = await new TenantRepository(c.env.DB).list(page);
  return c.json({ organizations: rows.slice(0, 20), page, has_more: rows.length > 20 });
});
tenantRoutes.post('/organizations', authenticated, superAdmin, async (c) => {
  const input = await body(c);
  return c.json({ organization: await new TenantRepository(c.env.DB).create(text(input.name, '机构名称')) }, 201);
});
tenantRoutes.patch('/organizations/:id', authenticated, superAdmin, async (c) => {
  const input = await body(c);
  const repository = new TenantRepository(c.env.DB);
  const old = await repository.get(c.req.param('id'));
  if (!old) throw new ApiError(404, 'NOT_FOUND', '机构不存在');
  const status = input.status === undefined ? old.status : input.status;
  if (status !== 'ACTIVE' && status !== 'DISABLED') throw new ApiError(400, 'INVALID_INPUT', '机构状态错误');
  const updated = await repository.update(old.id, input.name === undefined ? old.name : text(input.name, '机构名称'), status);
  if (!updated) throw new ApiError(404, 'NOT_FOUND', '机构不存在');
  return c.json({ organization: updated });
});
tenantRoutes.post('/invites', authenticated, async (c) => {
  const input = await body(c);
  return c.json(await createInvite(c.get('identity'), input.organization_id, c.env.DB), 201);
});
tenantRoutes.post('/invites/redeem', authenticated, async (c) => {
  const user = c.get('identity');
  if (user.role !== null || user.organization_id) throw new ApiError(409, 'ALREADY_BOUND', '当前账号无需绑定机构');
  const identity = new IdentityRepository(c.env.DB);
  if (!await identity.limit('redeem:' + user.id, 10)) throw new ApiError(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');
  const input = await body(c);
  const code = text(input.code, '邀请码', 40).toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{20}$/.test(code) || !await new TenantRepository(c.env.DB).redeem(await hash(code), user.id)) {
    throw new ApiError(409, 'INVITE_UNAVAILABLE', '邀请码无效、已使用、已过期或机构已停用');
  }
  const bound = await identity.find(user.id);
  if (!bound) throw new Error('Bound user missing');
  return c.json(publicIdentity(activeIdentity(bound, c.env)));
});
tenantRoutes.get('/admins', authenticated, async (c) => {
  const user = c.get('identity');
  if (user.role !== 'ORG_ADMIN' || !user.organization_id) throw new ApiError(403, 'FORBIDDEN', '请先加入机构');
  return c.json({ admins: await new TenantRepository(c.env.DB).admins(user.organization_id) });
});
