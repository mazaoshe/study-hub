import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { TestEntriesRepository } from './repositories/test-entries';
import type { AppEnv } from './domain/types';
import { ApiError } from './lib/errors';
import { identityRoutes } from './routes/identity';
import { tenantRoutes } from './routes/tenant';
import { catalogRoutes } from './routes/catalog';
import { ledgerRoutes } from './routes/ledger';
import { exportRoutes } from './routes/exports';
import { withdrawalRoutes } from './routes/withdrawals';
import { legacyRoutes } from './routes/legacy';
import { authenticated, orgAdmin } from './middleware/auth';

const app = new Hono<AppEnv>();
app.use('*', bodyLimit({ maxSize: 16384,
  onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: '内容过长' }, 413)
}));

app.get('/health', (c) => c.json({ ok: true }));

// Phase 0 endpoints are disabled unless explicitly enabled for validation.
app.use('/test', async (c, next) => {
  if (c.env.APP_ENV !== 'development' && c.env.APP_ENV !== 'validation') {
    return c.json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
  }
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/test', bodyLimit({ maxSize: 4096,
  onError: (c) => c.json({ error: 'PAYLOAD_TOO_LARGE', message: '内容过长' }, 413)
}));

app.get('/test', async (c) => {
  const entries = await new TestEntriesRepository(c.env.DB).list();
  return c.json({ entries });
});

app.post('/test', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'INVALID_JSON', message: '请求格式错误' }, 400); }
  const content = body && typeof body === 'object' && 'content' in body
    ? (body as { content: unknown }).content : undefined;
  if (typeof content !== 'string' || !content.trim() || content.trim().length > 200) {
    return c.json({ error: 'INVALID_CONTENT', message: '请输入 1～200 字的测试内容' }, 400);
  }
  const entry = await new TestEntriesRepository(c.env.DB).create(content.trim());
  return c.json({ entry }, 201);
});

app.route('/', identityRoutes);
app.route('/', tenantRoutes);
const business = new Hono<AppEnv>();
business.use('*', authenticated, orgAdmin);
business.route('/', catalogRoutes);
business.route('/', ledgerRoutes);
business.route('/', exportRoutes);
business.route('/', legacyRoutes);
business.route('/', withdrawalRoutes);
app.route('/', business);
app.notFound((c) => c.json({ error: 'NOT_FOUND', message: '接口不存在' }, 404));
app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.code, message: error.message }, error.status);
  console.error('Request failed', error.message);
  return c.json({ error: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' }, 500);
});

export default app;
