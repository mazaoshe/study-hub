import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { body, text } from '../lib/input';
import { hash } from '../lib/tokens';
import { authenticated } from '../middleware/auth';
import { IdentityRepository } from '../repositories/identity';
import { login, publicIdentity } from '../services/identity';

export const identityRoutes = new Hono<AppEnv>();
identityRoutes.post('/auth/login', async (c) => {
  const input = await body(c);
  const code = text(input.code, '微信登录凭证', 256);
  const ip = c.req.header('CF-Connecting-IP');
  if (ip && !await new IdentityRepository(c.env.DB).limit('login:' + await hash(ip), 30)) {
    throw new ApiError(429, 'RATE_LIMITED', '操作太频繁，请稍后再试');
  }
  c.header('Cache-Control', 'no-store');
  return c.json(await login(code, c.env));
});
identityRoutes.get('/me', authenticated, (c) => c.json(publicIdentity(c.get('identity'))));
identityRoutes.post('/auth/logout', authenticated, async (c) => {
  await new IdentityRepository(c.env.DB).logout(c.get('sessionHash'));
  return c.json({ ok: true });
});
