import { Hono } from 'hono';
import type { AppEnv } from '../domain/types';
import { ApiError } from '../lib/errors';
import { body, optionalText, text } from '../lib/input';

export const withdrawalRoutes = new Hono<AppEnv>();
withdrawalRoutes.get('/students/:id/withdrawal-preview', async c => {
  const row = await c.env.DB.prepare(`SELECT s.id, s.name, s.status, s.status_version, s.balance_version,
    (SELECT json_group_array(json_object('id', id, 'name', name, 'paid_balance', paid_balance,
      'gift_balance', gift_balance, 'status', status)) FROM (SELECT * FROM withdrawal_candidates
      WHERE student_id = s.id AND organization_id = s.organization_id ORDER BY id)) AS packages_json,
    (SELECT COUNT(*) FROM student_withdrawals WHERE student_id = s.id AND organization_id = s.organization_id) AS withdrawals
    FROM students s WHERE s.id = ?1 AND s.organization_id = ?2`)
    .bind(c.req.param('id'), c.get('identity').organization_id!).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, 'NOT_FOUND', '学员不存在');
  const packages = JSON.parse(String(row.packages_json)) as Array<{ id: string; name: string; paid_balance: number; gift_balance: number; status: string }>;
  const snapshot = JSON.stringify([row.status_version, row.balance_version]);
  return c.json({ student: { id: row.id, name: row.name, status: row.status }, packages, snapshot,
    blocked_reason: packages.some(p => p.paid_balance < 0) ? '存在透支课时，请先处理后再办理退学'
      : row.status === 'ARCHIVED' && Number(row.withdrawals) > 0 && !packages.length ? '该学员已办理退学结清' : '',
    last_withdrawal: await c.env.DB.prepare(`SELECT id, remark, created_at FROM student_withdrawals
      WHERE organization_id = ?1 AND student_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 1`)
      .bind(c.get('identity').organization_id!, row.id).first() });
});
withdrawalRoutes.post('/students/:id/withdraw', async c => {
  const input = await body(c), identity = c.get('identity'), org = identity.organization_id!;
  const student = c.req.param('id'), key = text(input.request_id, '操作编号', 80);
  const snapshot = text(input.expected_snapshot, '课时确认内容', 100), remark = optionalText(input.remark, '退学说明');
  if (input.refund_confirmed !== true) throw new ApiError(400, 'REFUND_NOT_CONFIRMED', '请先确认已完成线下退费');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([student, snapshot, remark, true])));
  const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  const existing = () => c.env.DB.prepare('SELECT * FROM student_withdrawals WHERE organization_id = ?1 AND request_id = ?2')
    .bind(org, key).first<Record<string, unknown>>();
  const response = async (record: Record<string, unknown>) => {
    if (record.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '操作编号已用于其他内容');
    const lines = await c.env.DB.prepare('SELECT * FROM withdrawal_lines WHERE withdrawal_id = ?1 AND organization_id = ?2')
      .bind(record.id, org).all();
    return c.json({ withdrawal: record, lines: lines.results });
  };
  const previous = await existing(); if (previous) return response(previous);
  try {
    // One insert and its triggers settle every package and archive the student atomically.
    await c.env.DB.prepare(`INSERT INTO student_withdrawals
      (id, organization_id, student_id, operator_id, request_id, request_hash, expected_snapshot, refund_confirmed, remark, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)`)
      .bind(crypto.randomUUID(), org, student, identity.id, key, hash, snapshot, remark, new Date().toISOString()).run();
  } catch (error) {
    const retry = await existing(); if (retry) return response(retry);
    const message = String(error);
    if (message.includes('WITHDRAWAL_ACTOR_DISABLED')) throw new ApiError(403, 'ORGANIZATION_DISABLED', '账号或机构已停用，请重新登录');
    if (message.includes('WITHDRAWAL_OVERDRAFT')) throw new ApiError(409, 'WITHDRAWAL_OVERDRAFT', '存在透支课时，请先处理后再办理退学');
    if (message.includes('WITHDRAWAL_BALANCE_CHANGED')) throw new ApiError(409, 'WITHDRAWAL_BALANCE_CHANGED', '课时包或余额已变化，请重新核对后提交');
    if (message.includes('WITHDRAWAL_UNAVAILABLE')) throw new ApiError(409, 'WITHDRAWAL_UNAVAILABLE', '学员不存在或已办理退学结清，请刷新查看');
    throw error;
  }
  return response((await existing())!);
});
