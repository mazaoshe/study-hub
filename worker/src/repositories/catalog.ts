export type Entity = Record<string, unknown> & { id: string; name: string; status: string };
export type CatalogTable = 'courses' | 'students';
export type CatalogSort = 'name' | 'balance' | 'newest' | 'archived';
const nameOrder = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });

export class CatalogRepository {
  constructor(private readonly db: D1Database, private readonly orgId: string) {}
  async list(table: CatalogTable, page: number, search: string, status: string | null, sort: CatalogSort = 'newest'): Promise<{ items: Entity[]; total: number }> {
    const filter = `WHERE t.organization_id = ?1 AND (?2 IS NULL OR t.status = ?2)
      AND (instr(lower(t.name), lower(?3)) > 0 ${table === 'students' ? 'OR instr(t.phone, ?3) > 0' : ''})`;
    const balances = table === 'students' ? `LEFT JOIN (
      SELECT student_id, SUM(paid_balance) AS paid_balance, SUM(gift_balance) AS gift_balance,
        SUM(paid_balance + gift_balance) AS total_balance, COUNT(*) AS package_count
      FROM lesson_packages WHERE organization_id = ?1 AND status = 'ACTIVE' GROUP BY student_id
    ) b ON b.student_id = t.id` : '';
    const fields = table === 'students' ? `, COALESCE(b.paid_balance, 0) AS paid_balance,
      COALESCE(b.gift_balance, 0) AS gift_balance, COALESCE(b.total_balance, 0) AS total_balance,
      COALESCE(b.package_count, 0) AS package_count` : '';
    const params = [this.orgId, status, search];
    if (table === 'students' && sort === 'name') {
      // D1's text collation is not Chinese pinyin. Sort the complete matching
      // name index before pagination, then fetch details for this page only.
      const names = await this.db.prepare(`SELECT t.id, t.name FROM students t ${filter}`)
        .bind(...params).all<{ id: string; name: string }>();
      names.results.sort((a, b) => nameOrder.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const ids = names.results.slice((page - 1) * 20, page * 20 + 1).map(item => item.id);
      if (!ids.length) return { items: [], total: names.results.length };
      const rows = await this.db.prepare(`SELECT t.* ${fields} FROM json_each(?4) ordered
        JOIN students t ON t.id = ordered.value ${balances} ${filter} ORDER BY CAST(ordered.key AS INTEGER)`)
        .bind(...params, JSON.stringify(ids)).all<Entity>();
      return { items: rows.results, total: names.results.length };
    }
    const order = table === 'students' && sort === 'balance' ? 'total_balance ASC, t.created_at DESC, t.id DESC'
      : table === 'students' && sort === 'archived' ? 't.archived_at DESC, t.created_at DESC, t.id DESC'
      : 't.created_at DESC, t.id DESC';
    const [rows, count] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(`SELECT t.* ${fields} FROM ${table} t ${balances} ${filter} ORDER BY ${order} LIMIT 21 OFFSET ?4`)
        .bind(...params, (page - 1) * 20),
      this.db.prepare(`SELECT COUNT(*) AS total FROM ${table} t ${filter}`).bind(...params)
    ]);
    return { items: rows.results as Entity[], total: Number(count.results[0].total) };
  }
  get(table: CatalogTable, id: string): Promise<Entity | null> {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?1 AND organization_id = ?2`)
      .bind(id, this.orgId).first<Entity>();
  }
  create(table: CatalogTable, name: string, remark: string, phone: string): Promise<Entity | null> {
    const now = new Date().toISOString();
    const query = table === 'students'
      ? 'INSERT INTO students (id, organization_id, name, remark, phone, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING *'
      : 'INSERT INTO courses (id, organization_id, name, remark, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING *';
    const params = [crypto.randomUUID(), this.orgId, name, remark, ...(table === 'students' ? [phone] : []), now];
    return this.db.prepare(query).bind(...params).first<Entity>();
  }
  update(table: CatalogTable, id: string, name: string, remark: string, phone: string, status: string | null, statusVersion: number | null = null): Promise<Entity | null> {
    const query = table === 'students'
      ? `UPDATE students SET name = ?3, remark = ?4,
          archived_at = CASE WHEN ?5 IS NULL THEN archived_at WHEN ?5 = 'ACTIVE' THEN NULL WHEN status = 'ACTIVE' THEN ?6 ELSE archived_at END,
          status = COALESCE(?5, status), updated_at = ?6, phone = ?7 WHERE id = ?1 AND organization_id = ?2
          AND (?8 IS NULL OR status_version = ?8) RETURNING *`
      : 'UPDATE courses SET name = ?3, remark = ?4, status = COALESCE(?5, status), updated_at = ?6 WHERE id = ?1 AND organization_id = ?2 RETURNING *';
    return this.db.prepare(query).bind(id, this.orgId, name, remark, status, new Date().toISOString(),
      ...(table === 'students' ? [phone, statusVersion] : [])).first<Entity>();
  }
  async packages(studentId: string): Promise<Entity[]> {
    const result = await this.db.prepare(`SELECT p.*, EXISTS(SELECT 1 FROM withdrawal_lines l WHERE l.lesson_package_id = p.id) AS settled
      FROM lesson_packages p WHERE student_id = ?1 AND organization_id = ?2
      ORDER BY created_at DESC, id DESC`).bind(studentId, this.orgId).all<Entity>();
    return result.results;
  }
  async package(id: string) {
    const row = await this.db.prepare(`SELECT p.*, s.name AS student_name, s.status AS student_status,
      EXISTS(SELECT 1 FROM withdrawal_lines l WHERE l.lesson_package_id = p.id) AS settled
      FROM lesson_packages p JOIN students s ON s.id = p.student_id
      WHERE p.id = ?1 AND p.organization_id = ?2`).bind(id, this.orgId).first<Entity>();
    if (!row) return null;
    const bindings = await this.db.prepare(`SELECT c.id, c.name, c.status FROM courses c
      JOIN lesson_package_courses pc ON pc.course_id = c.id
      WHERE pc.lesson_package_id = ?1 AND pc.organization_id = ?2 ORDER BY c.name, c.id`)
      .bind(id, this.orgId).all<Entity>();
    const opening = await this.db.prepare(`SELECT paid_hours, gift_hours, source_total, snapshot_at, allocation_note
      FROM legacy_openings WHERE lesson_package_id = ?1 AND organization_id = ?2`).bind(id, this.orgId).first();
    return { ...row, settled: Number(row.settled), courses: bindings.results, legacy_opening: opening };
  }
  async createPackage(studentId: string, name: string | undefined, courses: string[]): Promise<string> {
    if (name === undefined) {
      const rows = await this.db.prepare(`SELECT id, name FROM courses WHERE organization_id = ?1
        AND status = 'ACTIVE' AND id IN (SELECT value FROM json_each(?2))`)
        .bind(this.orgId, JSON.stringify(courses)).all<{ id: string; name: string }>();
      if (rows.results.length !== courses.length) throw new Error('COURSES_UNAVAILABLE');
      const names = new Map(rows.results.map(course => [course.id, course.name]));
      const label = courses.slice(0, 2).map(id => names.get(id)!).join('／') +
        (courses.length > 2 ? `等${courses.length}门课程` : '');
      name = label.slice(0, 77).replace(/[\uD800-\uDBFF]$/, '') + '课时包';
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT INTO lesson_packages (id, organization_id, student_id, name, created_at, updated_at)
        SELECT ?1, ?2, id, ?4, ?5, ?5 FROM students WHERE id = ?3 AND organization_id = ?2 AND status = 'ACTIVE'`)
        .bind(id, this.orgId, studentId, name, now),
      ...courses.map(course => this.binding(id, course, now))
    ]);
    return id;
  }
  private binding(id: string, course: string, now: string) {
    return this.db.prepare(`INSERT INTO lesson_package_courses (organization_id, lesson_package_id, course_id, created_at)
      VALUES (?1, ?2, (SELECT id FROM courses WHERE id = ?3 AND organization_id = ?1 AND status = 'ACTIVE'), ?4)`)
      .bind(this.orgId, id, course, now);
  }
  async updatePackage(id: string, name: string, status: string, courses?: string[]): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db.prepare('UPDATE lesson_packages SET name = ?3, status = ?4, updated_at = ?5 WHERE id = ?1 AND organization_id = ?2')
        .bind(id, this.orgId, name, status, now),
      ...(courses ? [
        this.db.prepare('DELETE FROM lesson_package_courses WHERE lesson_package_id = ?1 AND organization_id = ?2').bind(id, this.orgId),
        ...courses.map(course => this.binding(id, course, now))
      ] : [])
    ]);
  }
}
