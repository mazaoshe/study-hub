import type { Context } from 'hono';
import { ApiError } from './errors';

export async function body(c: Context): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await c.req.json(); }
  catch { throw new ApiError(400, 'INVALID_JSON', '请求格式错误'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_JSON', '请求格式错误');
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ApiError(400, 'INVALID_INPUT', `${label}需要填写，最多 ${max} 字`);
  }
  return value.trim();
}

export function optionalText(value: unknown, label: string, max = 500): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new ApiError(400, 'INVALID_INPUT', `${label}最多 ${max} 字`);
  return value.trim();
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ApiError(400, 'INVALID_INPUT', `${label}须为${minimum ? '正' : '非负'}整数`);
  }
  return value;
}

export function pageNumber(value?: string): number {
  const page = Number(value || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ApiError(400, 'INVALID_INPUT', '页码错误');
  return page;
}

export function entityStatus(value: unknown, old = 'ACTIVE'): string {
  const status = value === undefined ? old : value;
  if (status !== 'ACTIVE' && status !== 'ARCHIVED') throw new ApiError(400, 'INVALID_INPUT', '状态错误');
  return status;
}
