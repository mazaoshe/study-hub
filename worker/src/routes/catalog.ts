import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { body, entityStatus, optionalText, pageNumber, text } from '../lib/input';
import { CatalogRepository, type CatalogTable, type CatalogSort } from '../repositories/catalog';

export const catalogRoutes = new Hono<AppEnv>();

catalogRoutes.get('/dashboard', async c => {
  const org = c.get('identity').organization_id!;
  const page = pageNumber(c.req.query('page'));
  const search = optionalText(c.req.query('search'), '搜索内容', 80);
  const balances = `SELECT s.id, s.name, s.phone, COALESCE(SUM(p.paid_balance), 0) AS paid_balance,
    COALESCE(SUM(p.gift_balance), 0) AS gift_balance, COALESCE(SUM(p.paid_balance + p.gift_balance), 0) AS total_balance,
    COUNT(p.id) AS package_count FROM students s LEFT JOIN lesson_packages p ON p.student_id = s.id
      AND p.organization_id = s.organization_id AND p.status = 'ACTIVE'
    WHERE s.organization_id = ?1 AND s.status = 'ACTIVE'
      AND (?2 = '' OR instr(lower(s.name), lower(?2)) > 0 OR instr(s.phone, ?2) > 0)
    GROUP BY s.id HAVING ?2 != '' OR (COUNT(p.id) > 0 AND SUM(p.paid_balance + p.gift_balance) <= 3)`;
  const rows = await c.env.DB.prepare(`SELECT * FROM (${balances})
    ORDER BY ${search ? 'name, id' : 'total_balance, name, id'} LIMIT 21 OFFSET ?3`).bind(org, search, (page - 1) * 20).all();
  const count = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM (${balances})`).bind(org, search).first<{ count: number }>();
  return c.json({ students: rows.results.slice(0, 20), count: count?.count || 0, page, has_more: rows.results.length > 20 });
});

function courseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 ||
    value.some(id => typeof id !== 'string' || !id || id.length > 80) || new Set(value).size !== value.length) {
    throw new ApiError(400, 'INVALID_COURSES', '请选择 1～100 门不同的课程');
  }
  return value;
}

for (const table of ['courses', 'students'] as CatalogTable[]) {
  catalogRoutes.get('/' + table, async c => {
    const repository = new CatalogRepository(c.env.DB, c.get('identity').organization_id!);
    const page = pageNumber(c.req.query('page'));
    const status = c.req.query('status') !== undefined ? entityStatus(c.req.query('status'), 'ACTIVE')
      : c.req.query('archived') === '1' ? null : 'ACTIVE';
    const sort = c.req.query('sort') || (table === 'students' ? (status === 'ARCHIVED' ? 'archived' : 'name') : 'newest');
    if (!['name', 'balance', 'newest', 'archived'].includes(sort)) throw new ApiError(400, 'INVALID_INPUT', '排序方式错误');
    const result = await repository.list(table, page, optionalText(c.req.query('search'), '搜索内容', 80), status, sort as CatalogSort);
    return c.json({ items: result.items.slice(0, 20), total: result.total, page, has_more: result.items.length > 20 });
  });
  catalogRoutes.post('/' + table, async c => {
    const input = await body(c);
    const item = await new CatalogRepository(c.env.DB, c.get('identity').organization_id!).create(table,
      text(input.name, table === 'students' ? '学员姓名' : '课程名称'), optionalText(input.remark, '备注'), optionalText(input.phone, '电话', 40));
    return c.json({ item }, 201);
  });
  catalogRoutes.get('/' + table + '/:id', async c => {
    const item = await new CatalogRepository(c.env.DB, c.get('identity').organization_id!).get(table, c.req.param('id')!);
    if (!item) throw new ApiError(404, 'NOT_FOUND', '记录不存在');
    return c.json({ item });
  });
  catalogRoutes.patch('/' + table + '/:id', async c => {
    const input = await body(c);
    const repository = new CatalogRepository(c.env.DB, c.get('identity').organization_id!);
    const old = await repository.get(table, c.req.param('id')!);
    if (!old) throw new ApiError(404, 'NOT_FOUND', '记录不存在');
    const item = await repository.update(table, old.id, input.name === undefined ? old.name : text(input.name, '名称'),
      input.remark === undefined ? String(old.remark) : optionalText(input.remark, '备注'),
      input.phone === undefined ? String(old.phone || '') : optionalText(input.phone, '电话', 40), input.status === undefined ? null : entityStatus(input.status, old.status),
      table === 'students' && input.status !== undefined ? Number(old.status_version) : null);
    if (!item) throw new ApiError(409, 'STATUS_CHANGED', '学员状态已变化，请刷新后重试');
    return c.json({ item });
  });
}

catalogRoutes.get('/students/:id/packages', async c => {
  const repository = new CatalogRepository(c.env.DB, c.get('identity').organization_id!);
  if (!await repository.get('students', c.req.param('id')!)) throw new ApiError(404, 'NOT_FOUND', '学员不存在');
  return c.json({ packages: await repository.packages(c.req.param('id')!) });
});
catalogRoutes.post('/students/:id/packages', async c => {
  const input = await body(c);
  const repository = new CatalogRepository(c.env.DB, c.get('identity').organization_id!);
  const student = await repository.get('students', c.req.param('id')!);
  if (!student || student.status !== 'ACTIVE') throw new ApiError(409, 'STUDENT_UNAVAILABLE', '学员不存在或已归档');
  const name = input.name === undefined || (typeof input.name === 'string' && !input.name.trim())
    ? undefined : text(input.name, '课时包名称');
  const courses = courseIds(input.course_ids);
  let id: string;
  try { id = await repository.createPackage(student.id, name, courses); }
  catch { throw new ApiError(409, 'COURSES_UNAVAILABLE', '请选择本机构的正常课程'); }
  return c.json({ package: await repository.package(id) }, 201);
});
catalogRoutes.get('/packages/:id', async c => {
  const item = await new CatalogRepository(c.env.DB, c.get('identity').organization_id!).package(c.req.param('id')!);
  if (!item) throw new ApiError(404, 'NOT_FOUND', '课时包不存在');
  return c.json({ package: item });
});
catalogRoutes.patch('/packages/:id', async c => {
  const input = await body(c);
  const repository = new CatalogRepository(c.env.DB, c.get('identity').organization_id!);
  const old = await repository.package(c.req.param('id')!);
  if (!old) throw new ApiError(404, 'NOT_FOUND', '课时包不存在');
  if (old.settled) throw new ApiError(409, 'PACKAGE_SETTLED', '课时包已退学结清，重新报名请新建课时包');
  const name = input.name === undefined ? old.name : text(input.name, '课时包名称');
  const status = entityStatus(input.status, old.status);
  const courses = input.course_ids === undefined ? undefined : courseIds(input.course_ids);
  try { await repository.updatePackage(old.id, name, status, courses); }
  catch { throw new ApiError(409, 'COURSES_UNAVAILABLE', '请选择本机构的正常课程'); }
  return c.json({ package: await repository.package(old.id) });
});
