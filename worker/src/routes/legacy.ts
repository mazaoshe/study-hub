import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { pageNumber } from '../lib/input';

export const legacyRoutes = new Hono<AppEnv>();
legacyRoutes.get('/legacy-records', async c => {
  const page = pageNumber(c.req.query('page'));
  const rows = await c.env.DB.prepare(`SELECT h.*, s.name AS student_name, p.name AS package_name
    FROM legacy_history h JOIN students s ON s.id = h.student_id
    JOIN lesson_packages p ON p.id = h.lesson_package_id
    WHERE h.organization_id = ?1 AND (?2 = '' OR h.lesson_package_id = ?2) AND (?3 = '' OR h.student_id = ?3)
    ORDER BY h.source_created_at DESC, h.source_record_id DESC LIMIT 21 OFFSET ?4`)
    .bind(c.get('identity').organization_id!, c.req.query('package_id') || '', c.req.query('student_id') || '', (page - 1) * 20).all();
  return c.json({ items: rows.results.slice(0, 20), page, has_more: rows.results.length > 20 });
});
