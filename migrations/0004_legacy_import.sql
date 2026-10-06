-- Legacy history is evidence, not new ledger activity. Only an opening changes the balance.
CREATE TABLE legacy_imports (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source TEXT NOT NULL,
  source_organization_id INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  UNIQUE(source, source_organization_id),
  UNIQUE(id, organization_id)
);

CREATE TABLE legacy_openings (
  lesson_package_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  source_enrollment_id INTEGER NOT NULL,
  source_total INTEGER NOT NULL,
  paid_hours INTEGER NOT NULL CHECK(typeof(paid_hours) = 'integer' AND abs(paid_hours) <= 9007199254740991),
  gift_hours INTEGER NOT NULL CHECK(typeof(gift_hours) = 'integer' AND gift_hours >= 0 AND gift_hours <= 9007199254740991),
  snapshot_at TEXT NOT NULL,
  allocation_note TEXT NOT NULL,
  UNIQUE(import_id, source_enrollment_id),
  FOREIGN KEY(import_id, organization_id) REFERENCES legacy_imports(id, organization_id),
  FOREIGN KEY(lesson_package_id, student_id, organization_id) REFERENCES lesson_packages(id, student_id, organization_id)
);

CREATE TABLE legacy_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  lesson_package_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  source_record_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('add', 'subtract')),
  hours INTEGER NOT NULL CHECK(typeof(hours) = 'integer' AND hours >= 0),
  course_name TEXT,
  remark TEXT,
  source_created_at TEXT NOT NULL,
  use_date TEXT,
  deleted_at TEXT,
  UNIQUE(import_id, source_record_id),
  FOREIGN KEY(import_id, organization_id) REFERENCES legacy_imports(id, organization_id),
  FOREIGN KEY(lesson_package_id, student_id, organization_id) REFERENCES lesson_packages(id, student_id, organization_id)
);
CREATE INDEX legacy_history_org_date ON legacy_history(organization_id, source_created_at, source_record_id);
CREATE INDEX legacy_history_package ON legacy_history(organization_id, lesson_package_id, source_created_at, source_record_id);

CREATE TRIGGER legacy_opening_validate BEFORE INSERT ON legacy_openings
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_OPENING_REQUIRES_EMPTY_PACKAGE') WHERE EXISTS (
    SELECT 1 FROM lesson_packages p WHERE p.id = NEW.lesson_package_id AND (p.paid_balance != 0 OR p.gift_balance != 0)
  ) OR EXISTS (SELECT 1 FROM lesson_records WHERE lesson_package_id = NEW.lesson_package_id);
END;
CREATE TRIGGER legacy_opening_apply AFTER INSERT ON legacy_openings
BEGIN
  UPDATE lesson_packages SET paid_balance = NEW.paid_hours, gift_balance = NEW.gift_hours,
    updated_at = NEW.snapshot_at WHERE id = NEW.lesson_package_id AND organization_id = NEW.organization_id;
END;
CREATE TRIGGER legacy_openings_no_update BEFORE UPDATE ON legacy_openings
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
CREATE TRIGGER legacy_openings_no_delete BEFORE DELETE ON legacy_openings
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
CREATE TRIGGER legacy_history_no_update BEFORE UPDATE ON legacy_history
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
CREATE TRIGGER legacy_history_no_delete BEFORE DELETE ON legacy_history
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
CREATE TRIGGER legacy_imports_no_update BEFORE UPDATE ON legacy_imports
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
CREATE TRIGGER legacy_imports_no_delete BEFORE DELETE ON legacy_imports
BEGIN
  SELECT RAISE(ABORT, 'LEGACY_APPEND_ONLY');
END;
