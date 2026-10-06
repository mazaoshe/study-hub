CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  openid TEXT NOT NULL UNIQUE,
  role TEXT CHECK(role IN ('SUPER_ADMIN', 'ORG_ADMIN')),
  organization_id TEXT REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, organization_id),
  CHECK((role IS NOT NULL AND role = 'ORG_ADMIN' AND organization_id IS NOT NULL) OR
        (organization_id IS NULL AND (role IS NULL OR role = 'SUPER_ADMIN')))
);
CREATE INDEX users_org ON users(organization_id, status);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE organization_invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  used_by TEXT REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  CHECK((used_by IS NULL AND used_at IS NULL) OR (used_by IS NOT NULL AND used_at IS NOT NULL))
);
CREATE INDEX invites_org ON organization_invites(organization_id, expires_at);

-- Binding and claiming an invite must succeed together, even with concurrent redeemers.
CREATE TRIGGER invite_bind_user AFTER UPDATE OF used_by ON organization_invites
WHEN OLD.used_by IS NULL AND NEW.used_by IS NOT NULL
BEGIN
  UPDATE users SET organization_id = NEW.organization_id, role = 'ORG_ADMIN', updated_at = NEW.used_at
    WHERE id = NEW.used_by AND organization_id IS NULL AND role IS NULL AND status = 'ACTIVE';
  SELECT RAISE(ABORT, 'INVITE_BIND_CONFLICT') WHERE changes() != 1;
END;

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, organization_id)
);
CREATE INDEX courses_org ON courses(organization_id, status);

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  phone TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, organization_id)
);
CREATE INDEX students_org ON students(organization_id, status, name);

CREATE TABLE lesson_packages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  student_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  paid_balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(paid_balance) = 'integer'),
  gift_balance INTEGER NOT NULL DEFAULT 0 CHECK(typeof(gift_balance) = 'integer' AND gift_balance >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, organization_id),
  UNIQUE(id, student_id, organization_id),
  FOREIGN KEY(student_id, organization_id) REFERENCES students(id, organization_id)
);
CREATE INDEX packages_student ON lesson_packages(organization_id, student_id, status);

CREATE TABLE lesson_package_courses (
  organization_id TEXT NOT NULL,
  lesson_package_id TEXT NOT NULL,
  course_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(lesson_package_id, course_id),
  FOREIGN KEY(lesson_package_id, organization_id) REFERENCES lesson_packages(id, organization_id),
  FOREIGN KEY(course_id, organization_id) REFERENCES courses(id, organization_id)
);
CREATE INDEX package_courses_org ON lesson_package_courses(organization_id, course_id);

CREATE TABLE lesson_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  lesson_package_id TEXT NOT NULL,
  course_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('RECHARGE', 'CONSUME', 'REVERSAL')),
  paid_change INTEGER NOT NULL CHECK(typeof(paid_change) = 'integer'),
  gift_change INTEGER NOT NULL CHECK(typeof(gift_change) = 'integer'),
  original_record_id TEXT,
  request_id TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, request_id),
  UNIQUE(id, lesson_package_id, organization_id),
  CHECK((type = 'REVERSAL' AND original_record_id IS NOT NULL) OR
        (type != 'REVERSAL' AND original_record_id IS NULL)),
  CHECK(type != 'CONSUME' OR course_id IS NOT NULL),
  FOREIGN KEY(student_id, organization_id) REFERENCES students(id, organization_id),
  FOREIGN KEY(lesson_package_id, student_id, organization_id) REFERENCES lesson_packages(id, student_id, organization_id),
  FOREIGN KEY(course_id, organization_id) REFERENCES courses(id, organization_id),
  FOREIGN KEY(operator_id, organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY(original_record_id, lesson_package_id, organization_id)
    REFERENCES lesson_records(id, lesson_package_id, organization_id)
);
CREATE UNIQUE INDEX records_once_reversed ON lesson_records(original_record_id) WHERE type = 'REVERSAL';
CREATE INDEX records_org_date ON lesson_records(organization_id, created_at, id);
CREATE INDEX records_package_date ON lesson_records(organization_id, lesson_package_id, created_at, id);
CREATE TRIGGER records_no_update BEFORE UPDATE ON lesson_records
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY');
END;
CREATE TRIGGER records_no_delete BEFORE DELETE ON lesson_records
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_APPEND_ONLY');
END;

CREATE TABLE request_limits (
  key TEXT PRIMARY KEY,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL
);
