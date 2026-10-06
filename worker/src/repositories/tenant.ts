export interface Organization { id: string; name: string; status: string; created_at: string; updated_at: string }

export class TenantRepository {
  constructor(private readonly db: D1Database) {}
  async list(page: number): Promise<Organization[]> {
    const result = await this.db.prepare('SELECT * FROM organizations ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET ?1')
      .bind((page - 1) * 20).all<Organization>();
    return result.results;
  }
  get(id: string): Promise<Organization | null> {
    return this.db.prepare('SELECT * FROM organizations WHERE id = ?1').bind(id).first<Organization>();
  }
  async create(name: string): Promise<Organization> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.prepare('INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) RETURNING *')
      .bind(id, name, now).first<Organization>();
    if (!result) throw new Error('Organization insert failed');
    return result;
  }
  update(id: string, name: string, status: string): Promise<Organization | null> {
    return this.db.prepare('UPDATE organizations SET name = ?2, status = ?3, updated_at = ?4 WHERE id = ?1 RETURNING *')
      .bind(id, name, status, new Date().toISOString()).first<Organization>();
  }
  async createInvite(orgId: string, hash: string, operator: string, expires: number): Promise<boolean> {
    const result = await this.db.prepare(`INSERT INTO organization_invites
      (id, organization_id, code_hash, created_by, expires_at, created_at)
      SELECT ?1, id, ?3, ?4, ?5, ?6 FROM organizations WHERE id = ?2 AND status = 'ACTIVE'`)
      .bind(crypto.randomUUID(), orgId, hash, operator, expires, new Date().toISOString()).run();
    return result.meta.changes === 1;
  }
  async redeem(codeHash: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE organization_invites SET used_by = ?2, used_at = ?4
      WHERE code_hash = ?1 AND used_by IS NULL AND expires_at > ?3
      AND EXISTS (SELECT 1 FROM organizations WHERE id = organization_invites.organization_id AND status = 'ACTIVE')
      AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND organization_id IS NULL AND role IS NULL AND status = 'ACTIVE')
      RETURNING id`).bind(codeHash, userId, Math.floor(Date.now() / 1000), new Date().toISOString())
      .first<{ id: string }>();
    return !!result;
  }
  async admins(orgId: string) {
    const result = await this.db.prepare(`SELECT id, status, created_at FROM users
      WHERE organization_id = ?1 AND role = 'ORG_ADMIN' ORDER BY created_at, id`).bind(orgId).all();
    return result.results;
  }
}
