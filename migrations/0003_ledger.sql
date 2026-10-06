ALTER TABLE lesson_records ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

-- One INSERT performs the ledger write and balance update in the same transaction.
CREATE TRIGGER ledger_validate BEFORE INSERT ON lesson_records
BEGIN
  SELECT RAISE(ABORT, 'LEDGER_ACTOR_DISABLED') WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN organizations o ON o.id = u.organization_id
    WHERE u.id = NEW.operator_id AND u.organization_id = NEW.organization_id
      AND u.status = 'ACTIVE' AND o.status = 'ACTIVE'
  );
  SELECT RAISE(ABORT, 'LEDGER_INVALID_RECHARGE') WHERE NEW.type = 'RECHARGE'
    AND (NEW.paid_change < 0 OR NEW.gift_change < 0 OR NEW.paid_change + NEW.gift_change <= 0);
  SELECT RAISE(ABORT, 'LEDGER_INVALID_CONSUME') WHERE NEW.type = 'CONSUME'
    AND (NEW.paid_change > 0 OR NEW.gift_change > 0 OR NEW.paid_change + NEW.gift_change >= 0);
  SELECT RAISE(ABORT, 'LEDGER_INVALID_REVERSAL') WHERE NEW.type = 'REVERSAL' AND NOT EXISTS (
    SELECT 1 FROM lesson_records r WHERE r.id = NEW.original_record_id
      AND r.organization_id = NEW.organization_id AND r.lesson_package_id = NEW.lesson_package_id
      AND r.type IN ('RECHARGE', 'CONSUME')
      AND NEW.paid_change = -r.paid_change AND NEW.gift_change = -r.gift_change
      AND NEW.course_id IS r.course_id
  );
  SELECT RAISE(ABORT, 'GIFT_BALANCE_INSUFFICIENT') WHERE EXISTS (
    SELECT 1 FROM lesson_packages p WHERE p.id = NEW.lesson_package_id
      AND p.gift_balance + NEW.gift_change < 0
  );
  SELECT RAISE(ABORT, 'BALANCE_OUT_OF_RANGE') WHERE EXISTS (
    SELECT 1 FROM lesson_packages p WHERE p.id = NEW.lesson_package_id
      AND (abs(p.paid_balance + NEW.paid_change) > 9007199254740991
        OR p.gift_balance + NEW.gift_change > 9007199254740991)
  );
END;

CREATE TRIGGER ledger_apply AFTER INSERT ON lesson_records
BEGIN
  UPDATE lesson_packages SET paid_balance = paid_balance + NEW.paid_change,
    gift_balance = gift_balance + NEW.gift_change, updated_at = NEW.created_at
    WHERE id = NEW.lesson_package_id AND organization_id = NEW.organization_id;
END;
