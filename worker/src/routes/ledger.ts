import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { body, integer, optionalText, pageNumber, text } from '../lib/input';

export const ledgerRoutes = new Hono<AppEnv>();
const columns = 'id, organization_id, student_id, lesson_package_id, course_id, type, paid_change, gift_change, original_record_id, request_id, remark, operator_id, created_at, request_hash';

for (const operation of ['recharge', 'consume', 'reverse'] as const) {
  const path = operation === 'reverse' ? '/lesson-records/:id/reverse' : '/packages/:id/' + operation;
  ledgerRoutes.post(path, async c => {
    const input = await body(c);
    const identity = c.get('identity');
    const org = identity.organization_id!;
    const target = c.req.param('id');
    const key = text(input.request_id, '操作编号', 80);
    const remark = optionalText(input.remark, '备注');
    let paid = 0, gift = 0, amount = 0, course = '';
    if (operation === 'recharge') {
      paid = integer(input.paid_hours, '付费课时'); gift = integer(input.gift_hours, '赠送课时');
      if (!Number.isSafeInteger(paid + gift) || paid + gift <= 0) throw new ApiError(400, 'INVALID_INPUT', '充值总课时须为正整数');
    }
    if (operation === 'consume') { amount = integer(input.hours, '消课课时', 1); course = text(input.course_id, '课程编号'); }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([operation, target, paid, gift, amount, course, remark])));
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const existing = () => c.env.DB.prepare('SELECT * FROM lesson_records WHERE organization_id = ?1 AND request_id = ?2').bind(org, key).first<Record<string, unknown>>();
    const verify = (record: Record<string, unknown>) => {
      if (record.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '操作编号已用于其他内容，请刷新后重试');
      return c.json({ record });
    };
    const previous = await existing();
    if (previous) return verify(previous);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    let query: D1PreparedStatement;
    if (operation === 'reverse') {
      query = c.env.DB.prepare(`INSERT INTO lesson_records (${columns})
        SELECT ?1, r.organization_id, r.student_id, r.lesson_package_id, r.course_id, 'REVERSAL',
          -r.paid_change, -r.gift_change, r.id, ?5, ?6, ?7, ?8, ?9
        FROM lesson_records r WHERE r.id = ?3 AND r.organization_id = ?2 AND r.type != 'REVERSAL'
          AND NOT EXISTS (SELECT 1 FROM lesson_records x WHERE x.original_record_id = r.id)
        ON CONFLICT(organization_id, request_id) DO NOTHING`)
        .bind(id, org, target, null, key, remark, identity.id, now, hash);
    } else {
      const deltas = operation === 'consume' ? '-(?10 - min(p.gift_balance, ?10)), -min(p.gift_balance, ?10)' : '?10, ?11';
      query = c.env.DB.prepare(`INSERT INTO lesson_records (${columns})
        SELECT ?1, p.organization_id, p.student_id, p.id, ?4, '${operation === 'consume' ? 'CONSUME' : 'RECHARGE'}',
          ${deltas}, NULL, ?5, ?6, ?7, ?8, ?9
        FROM lesson_packages p JOIN students s ON s.id = p.student_id
        WHERE p.id = ?3 AND p.organization_id = ?2 AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
        ${operation === 'consume' ? `AND EXISTS (SELECT 1 FROM lesson_package_courses pc JOIN courses co ON co.id = pc.course_id
          WHERE pc.lesson_package_id = p.id AND pc.organization_id = ?2 AND pc.course_id = ?4 AND co.status = 'ACTIVE')` : ''}
        ON CONFLICT(organization_id, request_id) DO NOTHING`)
        .bind(id, org, target, operation === 'consume' ? course : null, key, remark, identity.id, now, hash,
          ...(operation === 'consume' ? [amount] : [paid, gift]));
    }
    try { await query.run(); }
    catch (error) {
      const retry = await existing();
      if (retry) return verify(retry);
      const message = String(error);
      if (message.includes('PACKAGE_SETTLED')) throw new ApiError(409, 'PACKAGE_SETTLED', '课时包已退学结清，不能修改历史余额');
      if (message.includes('LEDGER_ACTOR_DISABLED')) throw new ApiError(403, 'ORGANIZATION_DISABLED', '账号或机构已停用，请重新登录');
      if (message.includes('GIFT_BALANCE_INSUFFICIENT')) throw new ApiError(409, 'GIFT_BALANCE_INSUFFICIENT', '赠送课时已使用，无法冲正这笔充值');
      if (message.includes('BALANCE_OUT_OF_RANGE')) throw new ApiError(409, 'BALANCE_OUT_OF_RANGE', '课时余额超出允许范围');
      if (message.includes('records_once_reversed') || message.includes('lesson_records.original_record_id')) throw new ApiError(409, 'ALREADY_REVERSED', '这笔流水已冲正');
      throw error;
    }
    const record = await existing();
    if (!record) throw new ApiError(409, 'OPERATION_UNAVAILABLE', operation === 'reverse' ? '流水不存在、已冲正或不能再次冲正' : '学员、课时包或绑定课程已不可用');
    return verify(record);
  });
}

ledgerRoutes.get('/lesson-records', async c => {
  const page = pageNumber(c.req.query('page'));
  const rows = await c.env.DB.prepare(`SELECT r.*, p.name AS package_name, s.name AS student_name, co.name AS course_name,
      EXISTS(SELECT 1 FROM lesson_records x WHERE x.original_record_id = r.id) AS reversed,
      EXISTS(SELECT 1 FROM withdrawal_lines l WHERE l.lesson_package_id = r.lesson_package_id) AS settled
    FROM lesson_activity r LEFT JOIN lesson_packages p ON p.id = r.lesson_package_id JOIN students s ON s.id = r.student_id
    LEFT JOIN courses co ON co.id = r.course_id
    WHERE r.organization_id = ?1 AND (?2 = '' OR r.lesson_package_id = ?2) AND (?3 = '' OR r.student_id = ?3)
    ORDER BY r.created_at DESC, r.id DESC LIMIT 21 OFFSET ?4`)
    .bind(c.get('identity').organization_id!, c.req.query('package_id') || '', c.req.query('student_id') || '', (page - 1) * 20).all();
  return c.json({ items: rows.results.slice(0, 20), page, has_more: rows.results.length > 20 });
});
