export type Role = 'SUPER_ADMIN' | 'ORG_ADMIN' | null;
export interface Identity {
  id: string;
  openid: string;
  role: Role;
  organization_id: string | null;
  status: 'ACTIVE' | 'DISABLED';
  organization_name: string | null;
  organization_status: 'ACTIVE' | 'DISABLED' | null;
}
export interface Bindings {
  DB: D1Database;
  APP_ENV: string;
  WECHAT_APP_ID?: string;
  WECHAT_APP_SECRET?: string;
  SESSION_SECRET?: string;
  SUPER_ADMIN_OPENID?: string;
}
export type AppEnv = { Bindings: Bindings; Variables: { identity: Identity; sessionHash: string } };
