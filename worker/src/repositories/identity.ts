import type { Identity } from '../domain/types';

const identitySql = `SELECT u.id, u.openid, u.role, u.organization_id, u.status,
  o.name AS organization_name, o.status AS organization_status
  FROM users u LEFT JOIN organizations o ON o.id = u.organization_id`;

export class IdentityRepository {
  constructor(private readonly db: D1Database) {}
  async upsert(openid: string, superAdmin: boolean, now: string): Promise<Identity> {
    await this.db.prepare(`INSERT INTO users (id, openid, role, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(openid) DO UPDATE SET updated_at = excluded.updated_at,
        role = CASE WHEN users.organization_id IS NOT NULL THEN 'ORG_ADMIN' ELSE excluded.role END`)
      .bind(crypto.randomUUID(), openid, superAdmin ? 'SUPER_ADMIN' : null, now).run();
    const user = await this.db.prepare(identitySql + ' WHERE u.openid = ?1').bind(openid).first<Identity>();
    if (!user) throw new Error('User missing after upsert');
    return user;
  }
  find(id: string): Promise<Identity | null> {
    return this.db.prepare(identitySql + ' WHERE u.id = ?1').bind(id).first<Identity>();
  }
  bySession(tokenHash: string, now: number): Promise<Identity | null> {
    return this.db.prepare(identitySql + ` WHERE u.id =
      (SELECT user_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2)`)
      .bind(tokenHash, now).first<Identity>();
  }
  async saveSession(tokenHash: string, userId: string, expires: number, now: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(Math.floor(Date.now() / 1000)),
      this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(tokenHash, userId, expires, now)
    ]);
  }
  async logout(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
  }
  async limit(key: string, max: number): Promise<boolean> {
    const window = Math.floor(Date.now() / 60000);
    const row = await this.db.prepare(`INSERT INTO request_limits (key, window, count) VALUES (?1, ?2, 1)
      ON CONFLICT(key) DO UPDATE SET window = excluded.window,
        count = CASE WHEN request_limits.window = excluded.window THEN request_limits.count + 1 ELSE 1 END
      RETURNING count`).bind(key, window).first<{ count: number }>();
    return !!row && row.count <= max;
  }
}
