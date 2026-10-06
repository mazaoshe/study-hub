-- Existing archived students have no reliable archive timestamp; leave it unknown.
ALTER TABLE students ADD COLUMN archived_at TEXT;
