export interface TestEntry {
  id: number;
  content: string;
  created_at: string;
}

export class TestEntriesRepository {
  constructor(private readonly db: D1Database) {}

  async create(content: string): Promise<TestEntry> {
    const entry = await this.db.prepare(
      'INSERT INTO test_entries (content) VALUES (?1) RETURNING id, content, created_at'
    ).bind(content).first<TestEntry>();
    if (!entry) throw new Error('Insert returned no entry');
    return entry;
  }

  async list(): Promise<TestEntry[]> {
    const result = await this.db.prepare(
      'SELECT id, content, created_at FROM test_entries ORDER BY id DESC LIMIT 20'
    ).all<TestEntry>();
    return result.results;
  }
}
