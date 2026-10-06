import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';

export const exportRoutes = new Hono<AppEnv>();
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
const definitions = {
  students: { headers: ['学员编号', '姓名', '电话', '备注', '状态'], sql: 'SELECT id, name, phone, remark, status FROM students', fields: ['id', 'name', 'phone', 'remark', 'status'] },
  packages: { headers: ['课时包编号', '学员', '课时包', '付费余额', '赠送余额', '绑定课程', '状态'],
    sql: `SELECT p.id, s.name AS student, p.name, p.paid_balance, p.gift_balance,
      (SELECT group_concat(c.name, ' / ') FROM lesson_package_courses pc JOIN courses c ON c.id = pc.course_id WHERE pc.lesson_package_id = p.id) AS courses, p.status
      FROM lesson_packages p JOIN students s ON s.id = p.student_id`, fields: ['id', 'student', 'name', 'paid_balance', 'gift_balance', 'courses', 'status'] },
  records: { headers: ['流水编号', '学员', '课时包', '课程', '类型', '付费变动', '赠送变动', '原流水', '备注', '操作人编号', '时间'],
    sql: `SELECT r.id, s.name AS student, p.name AS package, c.name AS course, r.type, r.paid_change, r.gift_change, r.original_record_id, r.remark, r.operator_id, r.created_at
      FROM lesson_activity r JOIN students s ON s.id = r.student_id LEFT JOIN lesson_packages p ON p.id = r.lesson_package_id LEFT JOIN courses c ON c.id = r.course_id`,
    fields: ['id', 'student', 'package', 'course', 'type', 'paid_change', 'gift_change', 'original_record_id', 'remark', 'operator_id', 'created_at'] },
  'legacy-records': { headers: ['记录编号', '学员', '课时包', '课程名称', '操作', '课时', '备注', '记录时间', '使用日期', '删除时间'],
    sql: `SELECT r.source_record_id, s.name AS student, p.name AS package, r.course_name, r.action, r.hours, r.remark,
      r.source_created_at, r.use_date, r.deleted_at FROM legacy_history r JOIN students s ON s.id = r.student_id
      JOIN lesson_packages p ON p.id = r.lesson_package_id`,
    fields: ['source_record_id', 'student', 'package', 'course_name', 'action', 'hours', 'remark', 'source_created_at', 'use_date', 'deleted_at'] },
  'legacy-openings': { headers: ['课时包编号', '学员', '旧报名编号', '旧总课时', '结转付费', '结转赠送', '快照时间', '结转说明'],
    sql: `SELECT r.lesson_package_id AS id, s.name AS student, r.source_enrollment_id, r.source_total, r.paid_hours,
      r.gift_hours, r.snapshot_at, r.allocation_note FROM legacy_openings r JOIN students s ON s.id = r.student_id`,
    fields: ['id', 'student', 'source_enrollment_id', 'source_total', 'paid_hours', 'gift_hours', 'snapshot_at', 'allocation_note'] }
};
exportRoutes.get('/exports/:kind', async c => {
  const kind = c.req.param('kind') as keyof typeof definitions;
  const definition = Object.hasOwn(definitions, kind) ? definitions[kind] : undefined;
  if (!definition) throw new ApiError(404, 'NOT_FOUND', '导出类型不存在');
  const alias = kind === 'students' ? '' : kind === 'packages' ? 'p.' : 'r.';
  const org = c.get('identity').organization_id!;
  // Freeze the row set; later records will be included in the next export.
  const order = kind === 'legacy-openings' ? 'r.lesson_package_id' : `${alias}id`;
  const query = `${definition.sql} WHERE ${alias}organization_id = ?1 ORDER BY ${order}`;
  const rows = await c.env.DB.prepare(query).bind(org).all<Record<string, unknown>>();
  const csv = '\uFEFF' + definition.headers.map(csvCell).join(',') + '\r\n' +
    rows.results.map(row => definition.fields.map(field => csvCell(kind === 'students' && field === 'remark'
      ? String(row[field] || '').replace(/^\s*StudyHub\s+旧学员编号\s+\S+\s*$/gm, '').trim() : row[field])).join(',')).join('\r\n');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${kind}.csv"`, 'Cache-Control': 'no-store' } });
});
