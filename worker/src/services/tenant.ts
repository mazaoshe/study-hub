import type { Identity } from '../domain/types';
import { ApiError } from '../lib/errors';
import { hash, inviteCode } from '../lib/tokens';
import { TenantRepository } from '../repositories/tenant';

export async function createInvite(user: Identity, requestedOrg: unknown, db: D1Database) {
  const orgId = user.role === 'SUPER_ADMIN' ? requestedOrg : user.organization_id;
  if (user.role === null || typeof orgId !== 'string' || !orgId) {
    throw new ApiError(403, 'FORBIDDEN', '请先加入机构');
  }
  // Organization administrators cannot select another tenant, including through a forged request body.
  if (user.role === 'ORG_ADMIN' && requestedOrg !== undefined && requestedOrg !== user.organization_id) {
    throw new ApiError(403, 'FORBIDDEN', '只能邀请自己机构的管理员');
  }
  const code = inviteCode();
  const expires = Math.floor(Date.now() / 1000) + 7 * 86400;
  if (!await new TenantRepository(db).createInvite(orgId, await hash(code), user.id, expires)) {
    throw new ApiError(409, 'ORGANIZATION_UNAVAILABLE', '机构不存在或已停用');
  }
  return { code, expires_at: expires };
}
