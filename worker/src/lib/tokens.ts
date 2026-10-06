import { ApiError } from './errors';

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), n => alphabet[n & 31]).join('');
}
export async function hash(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, '0')).join('');
}
export async function sessionHash(token: string, secret?: string): Promise<string> {
  if (!secret || secret.length < 32) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', '登录服务尚未配置，请联系管理员');
  }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
