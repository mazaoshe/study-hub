-- A transferred login gets a new active user row. The retired row remains the
-- historical actor so immutable ledger and invitation references never change.
CREATE TABLE admin_transfers (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL UNIQUE,
  to_user_id TEXT NOT NULL UNIQUE,
  from_organization_id TEXT NOT NULL,
  to_organization_id TEXT NOT NULL,
  transferred_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  CHECK(from_user_id != to_user_id AND from_organization_id != to_organization_id),
  FOREIGN KEY(from_user_id, from_organization_id) REFERENCES users(id, organization_id),
  FOREIGN KEY(to_user_id, to_organization_id) REFERENCES users(id, organization_id)
);
CREATE TRIGGER admin_transfers_no_update BEFORE UPDATE ON admin_transfers
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_TRANSFER_APPEND_ONLY');
END;
CREATE TRIGGER admin_transfers_no_delete BEFORE DELETE ON admin_transfers
BEGIN
  SELECT RAISE(ABORT, 'ADMIN_TRANSFER_APPEND_ONLY');
END;
