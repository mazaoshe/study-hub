"""Prepare an additive D1 SQL file and prove it against a pre-cutover backup.

No network writes. Remote execution uses Wrangler's file-import operation, which
restores the original database state on import failure. Never execute these
statements one at a time through the query API.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid

from studyhub_trial import ROOT, verify


def quoted(value):
    if isinstance(value, str) and '\x00' in value:
        raise ValueError('NUL byte cannot be represented in an SQL literal')
    if value is None:
        return 'NULL'
    if type(value) is int:
        return str(value)
    if not isinstance(value, str):
        raise ValueError('Unsupported SQL parameter type')
    return "'" + value.replace("'", "''") + "'"


def render(statement):
    pieces = statement['sql'].split('?')
    if len(pieces) != len(statement['params']) + 1:
        raise ValueError('Parameter mismatch')
    return ''.join(a + quoted(b) for a, b in zip(pieces, statement['params'])) + pieces[-1] + ';'


def compile_cutover(plan, old_user, old_org, timestamp):
    org = plan['target_org']
    new_user = str(uuid.uuid5(uuid.NAMESPACE_URL, f'studyhub-admin-transfer/{old_user}/{org}'))
    transfer_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'studyhub-admin-transfer-audit/{old_user}/{org}'))
    Q = quoted
    guard = '_studyhub_cutover_guard'
    sql = [f'CREATE TABLE {guard} (ok INTEGER NOT NULL CHECK(ok = 1));',
           f'INSERT INTO {guard} SELECT NOT EXISTS (SELECT 1 FROM organizations WHERE id={Q(org)} OR name={Q(plan["target_name"])});',
           f'INSERT INTO {guard} SELECT COUNT(*) = 1 FROM users WHERE id={Q(old_user)} AND organization_id={Q(old_org)} AND role=\'ORG_ADMIN\' AND status=\'ACTIVE\';',
           f'INSERT INTO {guard} SELECT COUNT(*) = 1 FROM organizations WHERE id={Q(old_org)} AND status=\'ACTIVE\';',
           'CREATE TABLE _studyhub_admin_stage (old_id TEXT PRIMARY KEY, original_openid TEXT NOT NULL UNIQUE);',
           f'INSERT INTO _studyhub_admin_stage SELECT id,openid FROM users WHERE id={Q(old_user)};']
    sql += [render(s) for s in plan['statements']]
    sql += [
        f'INSERT INTO {guard} SELECT COUNT(*)={len(plan["expected"])} AND SUM(paid_balance)={plan["summary"]["balance_total"]} AND SUM(gift_balance)=0 FROM lesson_packages WHERE organization_id={Q(org)};',
        f'INSERT INTO {guard} SELECT COUNT(*)={len(plan["history"])} FROM legacy_history WHERE organization_id={Q(org)};',
        f'UPDATE users SET openid={Q("retired:" + old_user)}, status=\'DISABLED\', updated_at={Q(timestamp)} WHERE id={Q(old_user)};',
        f'INSERT INTO users (id,openid,role,organization_id,status,created_at,updated_at) SELECT {Q(new_user)},original_openid,\'ORG_ADMIN\',{Q(org)},\'ACTIVE\',{Q(timestamp)},{Q(timestamp)} FROM _studyhub_admin_stage WHERE old_id={Q(old_user)};',
        f'INSERT INTO admin_transfers VALUES ({Q(transfer_id)},{Q(old_user)},{Q(new_user)},{Q(old_org)},{Q(org)},{Q(timestamp)},\'用户授权从寒门站所转入一尘书画院；原身份仅用于历史审计\');',
        f'DELETE FROM sessions WHERE user_id={Q(old_user)};',
        f'INSERT INTO {guard} SELECT COUNT(*)=1 FROM users u JOIN _studyhub_admin_stage s ON u.openid=s.original_openid WHERE u.id={Q(new_user)} AND u.organization_id={Q(org)} AND u.status=\'ACTIVE\';',
        f'INSERT INTO {guard} SELECT COUNT(*)=0 FROM sessions WHERE user_id={Q(old_user)};',
        'DROP TABLE _studyhub_admin_stage;', f'DROP TABLE {guard};'
    ]
    return '\n'.join(sql) + '\n', new_user, transfer_id


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--backup', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--admin-id', required=True)
    p.add_argument('--from-org', required=True)
    args = p.parse_args()
    os.umask(0o077)
    if args.output.exists():
        raise ValueError('Output already exists')
    plan = json.loads(args.plan.read_text())
    db = sqlite3.connect(':memory:')
    db.executescript(args.backup.read_text())
    db.execute('PRAGMA foreign_keys=ON')
    original_tables = ['organizations', 'users', 'sessions', 'organization_invites', 'students', 'courses', 'lesson_packages', 'lesson_package_courses', 'lesson_records']
    before = {t: db.execute('SELECT * FROM ' + t).fetchall() for t in original_tables}
    account = db.execute('SELECT openid FROM users WHERE id=? AND role=\'ORG_ADMIN\' AND status=\'ACTIVE\' AND organization_id=?', (args.admin_id, args.from_org)).fetchone()
    if account is None:
        raise ValueError('Authorized admin not found in backup')
    for migration in ['0004_legacy_import.sql', '0005_admin_transfers.sql']:
        db.executescript((ROOT / 'migrations' / migration).read_text())
    timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    sql, new_user, transfer_id = compile_cutover(plan, args.admin_id, args.from_org, timestamp)
    db.executescript('BEGIN;\n' + sql + '\nCOMMIT;')
    verify(db, plan)
    for table in ['organization_invites', 'lesson_records']:
        assert db.execute('SELECT * FROM ' + table).fetchall() == before[table], f'Original {table} changed'
    for table in ['organizations', 'students', 'courses', 'lesson_packages']:
        for row in before[table]:
            assert db.execute('SELECT * FROM ' + table + ' WHERE id=?', (row[0],)).fetchone() == row, f'Original {table} changed'
    for row in before['lesson_package_courses']:
        assert db.execute('SELECT * FROM lesson_package_courses WHERE lesson_package_id=? AND course_id=?', (row[1], row[2])).fetchone() == row
    for row in before['users']:
        if row[0] != args.admin_id:
            assert db.execute('SELECT * FROM users WHERE id=?', (row[0],)).fetchone() == row, 'Unselected user changed'
    assert db.execute('SELECT openid,organization_id,status FROM users WHERE id=?', (new_user,)).fetchone() == (account[0], plan['target_org'], 'ACTIVE')
    assert db.execute('SELECT status,organization_id FROM users WHERE id=?', (args.admin_id,)).fetchone() == ('DISABLED', args.from_org)
    assert db.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?', (args.admin_id,)).fetchone()[0] == 0
    expected_sessions = [r for r in before['sessions'] if r[1] != args.admin_id]
    assert db.execute('SELECT * FROM sessions').fetchall() == expected_sessions
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    # Duplicate application fails before touching data; rollback preserves every row.
    imported = list(db.iterdump())
    try:
        db.executescript('BEGIN;\n' + sql + '\nCOMMIT;')
        raise AssertionError('Repeated cutover unexpectedly succeeded')
    except sqlite3.IntegrityError:
        db.rollback()
    assert list(db.iterdump()) == imported
    args.output.write_text(sql)
    evidence = {'organization': plan['target_name'], 'source_snapshot_hash': plan['snapshot_hash'],
                'old_admin_id': args.admin_id, 'new_admin_id': new_user, 'transfer_id': transfer_id,
                'target_org_id': plan['target_org'], 'backup_sha256': hashlib.sha256(args.backup.read_bytes()).hexdigest(),
                'sql_sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'sql_bytes': args.output.stat().st_size,
                'existing_business_rows_unchanged': True, 'other_admins_unchanged': True, 'selected_admin_sessions_revoked': True,
                'same_wechat_identity_transferred': True, 'historical_actor_preserved': True, 'duplicate_cutover_rejected': True,
                'foreign_keys_verified': True, 'package_count': len(plan['expected']), 'history_count': len(plan['history'])}
    args.output.with_suffix('.verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
