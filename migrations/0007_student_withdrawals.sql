-- Monotonic revisions detect activity even when balances later return to the same values.
ALTER TABLE students ADD COLUMN balance_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN status_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER package_version AFTER UPDATE OF paid_balance, gift_balance, status ON lesson_packages
BEGIN
  UPDATE students SET balance_version = balance_version + 1 WHERE id = NEW.student_id;
END;
CREATE TRIGGER package_insert_version AFTER INSERT ON lesson_packages
BEGIN
  UPDATE students SET balance_version = balance_version + 1 WHERE id = NEW.student_id;
END;
CREATE TRIGGER package_delete_version AFTER DELETE ON lesson_packages
BEGIN
  UPDATE students SET balance_version = balance_version + 1 WHERE id = OLD.student_id;
END;
CREATE TRIGGER student_status_version AFTER UPDATE OF status ON students
WHEN NEW.status != OLD.status
BEGIN
  UPDATE students SET status_version = status_version + 1 WHERE id = NEW.id;
END;

-- A separate immutable settlement journal avoids rewriting the existing ledger.
CREATE TABLE student_withdrawals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_snapshot TEXT NOT NULL,
  refund_confirmed INTEGER NOT NULL CHECK(refund_confirmed = 1),
  remark TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, request_id),
  UNIQUE(id, student_id, organization_id),
  FOREIGN KEY(student_id, organization_id) REFERENCES students(id, organization_id),
  FOREIGN KEY(operator_id, organization_id) REFERENCES users(id, organization_id)
);
CREATE INDEX withdrawals_student ON student_withdrawals(organization_id, student_id);

CREATE TABLE withdrawal_lines (
  id TEXT PRIMARY KEY,
  withdrawal_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  lesson_package_id TEXT NOT NULL UNIQUE,
  paid_change INTEGER NOT NULL CHECK(typeof(paid_change) = 'integer' AND paid_change <= 0),
  gift_change INTEGER NOT NULL CHECK(typeof(gift_change) = 'integer' AND gift_change <= 0),
  FOREIGN KEY(withdrawal_id, student_id, organization_id) REFERENCES student_withdrawals(id, student_id, organization_id),
  FOREIGN KEY(lesson_package_id, student_id, organization_id) REFERENCES lesson_packages(id, student_id, organization_id)
);
CREATE INDEX withdrawal_lines_header ON withdrawal_lines(withdrawal_id);

CREATE VIEW withdrawal_candidates AS
SELECT p.* FROM lesson_packages p
WHERE NOT EXISTS (SELECT 1 FROM withdrawal_lines l WHERE l.lesson_package_id = p.id);

CREATE TRIGGER withdrawal_validate BEFORE INSERT ON student_withdrawals
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_ACTOR_DISABLED') WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN organizations o ON o.id = u.organization_id
    WHERE u.id = NEW.operator_id AND u.organization_id = NEW.organization_id
      AND u.role = 'ORG_ADMIN' AND u.status = 'ACTIVE' AND o.status = 'ACTIVE'
  );
  SELECT RAISE(ABORT, 'WITHDRAWAL_UNAVAILABLE') WHERE NOT EXISTS (
    SELECT 1 FROM students s WHERE s.id = NEW.student_id AND s.organization_id = NEW.organization_id
      AND (s.status = 'ACTIVE' OR EXISTS (SELECT 1 FROM withdrawal_candidates p WHERE p.student_id = s.id)
        OR NOT EXISTS (SELECT 1 FROM student_withdrawals w WHERE w.student_id = s.id))
  );
  SELECT RAISE(ABORT, 'WITHDRAWAL_BALANCE_CHANGED') WHERE NEW.expected_snapshot != (
    SELECT json_array(status_version, balance_version) FROM students WHERE id = NEW.student_id
  );
  SELECT RAISE(ABORT, 'WITHDRAWAL_OVERDRAFT') WHERE EXISTS (
    SELECT 1 FROM withdrawal_candidates WHERE student_id = NEW.student_id
      AND organization_id = NEW.organization_id AND paid_balance < 0
  );
END;

CREATE TRIGGER withdrawal_line_validate BEFORE INSERT ON withdrawal_lines
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_INVALID_LINE') WHERE NOT EXISTS (
    SELECT 1 FROM lesson_packages p WHERE p.id = NEW.lesson_package_id AND p.student_id = NEW.student_id
      AND p.organization_id = NEW.organization_id AND p.paid_balance = -NEW.paid_change
      AND p.gift_balance = -NEW.gift_change
  );
END;

CREATE TRIGGER withdrawal_apply AFTER INSERT ON student_withdrawals
BEGIN
  INSERT INTO withdrawal_lines (id, withdrawal_id, organization_id, student_id, lesson_package_id, paid_change, gift_change)
    SELECT NEW.id || ':' || p.id, NEW.id, NEW.organization_id, NEW.student_id, p.id, -p.paid_balance, -p.gift_balance
    FROM withdrawal_candidates p WHERE p.student_id = NEW.student_id AND p.organization_id = NEW.organization_id;
  UPDATE lesson_packages SET paid_balance = 0, gift_balance = 0, status = 'ARCHIVED', updated_at = NEW.created_at
    WHERE id IN (SELECT lesson_package_id FROM withdrawal_lines WHERE withdrawal_id = NEW.id);
  UPDATE students SET status = 'ARCHIVED', archived_at = NEW.created_at, updated_at = NEW.created_at
    WHERE id = NEW.student_id AND organization_id = NEW.organization_id;
END;

CREATE TRIGGER settled_package_no_balance BEFORE UPDATE ON lesson_packages
WHEN EXISTS (SELECT 1 FROM withdrawal_lines WHERE lesson_package_id = OLD.id)
  AND (NEW.paid_balance != 0 OR NEW.gift_balance != 0 OR NEW.status != 'ARCHIVED')
BEGIN
  SELECT RAISE(ABORT, 'PACKAGE_SETTLED');
END;
CREATE TRIGGER settled_package_no_ledger BEFORE INSERT ON lesson_records
WHEN EXISTS (SELECT 1 FROM withdrawal_lines WHERE lesson_package_id = NEW.lesson_package_id)
BEGIN
  SELECT RAISE(ABORT, 'PACKAGE_SETTLED');
END;
CREATE TRIGGER settled_package_no_opening BEFORE INSERT ON legacy_openings
WHEN EXISTS (SELECT 1 FROM withdrawal_lines WHERE lesson_package_id = NEW.lesson_package_id)
BEGIN
  SELECT RAISE(ABORT, 'PACKAGE_SETTLED');
END;
CREATE TRIGGER withdrawals_no_update BEFORE UPDATE ON student_withdrawals
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_APPEND_ONLY');
END;
CREATE TRIGGER withdrawals_no_delete BEFORE DELETE ON student_withdrawals
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_APPEND_ONLY');
END;
CREATE TRIGGER withdrawal_lines_no_update BEFORE UPDATE ON withdrawal_lines
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_APPEND_ONLY');
END;
CREATE TRIGGER withdrawal_lines_no_delete BEFORE DELETE ON withdrawal_lines
BEGIN
  SELECT RAISE(ABORT, 'WITHDRAWAL_APPEND_ONLY');
END;

CREATE VIEW lesson_activity AS
SELECT r.* FROM lesson_records r
UNION ALL
SELECT l.id, l.organization_id, l.student_id, l.lesson_package_id, NULL, 'WITHDRAWAL',
  l.paid_change, l.gift_change, NULL, w.request_id, w.remark, w.operator_id, w.created_at, w.request_hash
FROM withdrawal_lines l JOIN student_withdrawals w ON w.id = l.withdrawal_id
UNION ALL
SELECT w.id, w.organization_id, w.student_id, NULL, NULL, 'WITHDRAWAL',
  0, 0, NULL, w.request_id, w.remark, w.operator_id, w.created_at, w.request_hash
FROM student_withdrawals w WHERE NOT EXISTS (SELECT 1 FROM withdrawal_lines l WHERE l.withdrawal_id = w.id);
