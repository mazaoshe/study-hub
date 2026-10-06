"""Offline StudyHub conversion and trial import. No network or production writes."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'studyhub:study-hub'
ALLOCATION = '旧系统剩余课时结转；原付费与赠送构成未知，暂计入付费余额，不代表本次充值。'
TABLES = ('edu_organization', 'edu_course', 'sys_users', 'edu_enrollment', 'edu_class_session', 'sys_user_authority')


def stable(kind, source_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{SOURCE}/{kind}/{source_id}'))


def integer(value, label, minimum=None):
    if type(value) is not int or abs(value) > 9007199254740991 or (minimum is not None and value < minimum):
        raise ValueError(f'Invalid integer: {label}')
    return value


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip().encode('utf-16-le')) // 2 > 80:
        raise ValueError('Missing or oversized name; manual review required')
    return value.strip()


def index(rows):
    result = {r['id']: r for r in rows}
    if len(result) != len(rows):
        raise ValueError('Duplicate source IDs')
    return result


def build_plan(snapshot, org_id, target_name):
    snapshot = Path(snapshot)
    manifest = json.loads((snapshot / 'manifest.json').read_text())
    if manifest.get('status') != 'complete' or manifest.get('source_database') != 'study-hub':
        raise ValueError('Unexpected or incomplete snapshot')
    hashes, data = {}, {}
    for table in TABLES:
        rel = f'tables/{table}.json'
        content = (snapshot / rel).read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if manifest['sha256'].get(rel) != digest:
            raise ValueError(f'Snapshot checksum mismatch: {table}')
        hashes[table] = digest
        data[table] = json.loads(content)
    snapshot_hash = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    orgs, courses, users, enrollments = (index(data[t]) for t in TABLES[:4])
    if org_id not in orgs or orgs[org_id]['deleted_at']:
        raise ValueError('Source organization missing or deleted')
    target_name = name(target_name)
    target_org = stable('organization', org_id)
    import_id = stable('import', org_id)
    timestamp = datetime.fromisoformat(manifest['exported_at']).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    course_rows = [r for r in courses.values() if r['organization_id'] == org_id]
    eligible, quarantine = [], []
    selected_courses = {r['id'] for r in course_rows}
    for row in enrollments.values():
        if row['course_id'] not in courses:
            raise ValueError(f'Unknown course for enrollment {row["id"]}')
        if row['course_id'] not in selected_courses:
            continue
        if row['user_id'] not in users:
            quarantine.append({'reason': 'missing_user', 'enrollment': row,
                               'history': [s for s in data['edu_class_session'] if s['enrollment_id'] == row['id']]})
            continue
        if users[row['user_id']]['edu_organization_id'] != org_id:
            raise ValueError(f'Cross-organization enrollment {row["id"]}')
        eligible.append(row)
    student_ids = {r['user_id'] for r in eligible}
    student_ids |= {r['id'] for r in users.values() if r['edu_organization_id'] == org_id and r['authority_id'] == 222}
    student_ids |= {r['sys_user_id'] for r in data['sys_user_authority'] if r['sys_authority_authority_id'] == 222 and r['sys_user_id'] in users and users[r['sys_user_id']]['edu_organization_id'] == org_id}
    statements = []

    def add(table, row):
        fields = ', '.join(row)
        sql = f'INSERT INTO {table} ({fields}) VALUES ({", ".join("?" for _ in row)})'
        statements.append({'sql': sql, 'params': list(row.values())})

    add('organizations', {'id': target_org, 'name': target_name, 'created_at': timestamp, 'updated_at': timestamp})
    add('legacy_imports', {'id': import_id, 'organization_id': target_org, 'source': SOURCE, 'source_organization_id': org_id,
                           'snapshot_hash': snapshot_hash, 'snapshot_at': timestamp})
    for row in course_rows:
        add('courses', {'id': stable('course', row['id']), 'organization_id': target_org, 'name': name(row['course_name']),
                        'remark': row['description'] or '', 'status': 'ARCHIVED' if row['deleted_at'] else 'ACTIVE',
                        'created_at': timestamp, 'updated_at': timestamp})
    archived_students = set()
    for sid in sorted(student_ids):
        row = users[sid]
        if row['enable'] not in (1, 2):
            raise ValueError(f'Unknown user status: {sid}')
        if row['deleted_at'] or row['enable'] == 2:
            archived_students.add(sid)
        phone = row['phone'] or ''
        if len(phone) > 40:
            raise ValueError(f'Oversized phone: {sid}')
        add('students', {'id': stable('student', sid), 'organization_id': target_org, 'name': name(row['nick_name']), 'phone': phone,
                         'remark': f'StudyHub 旧学员编号 {sid}', 'status': 'ARCHIVED' if sid in archived_students else 'ACTIVE',
                         'created_at': timestamp, 'updated_at': timestamp})
    expected = []
    for row in eligible:
        balance = integer(row['remaining_sessions'], f'remaining_sessions/{row["id"]}')
        total = integer(row['total_sessions'], f'total_sessions/{row["id"]}')
        pid, sid = stable('package', row['id']), stable('student', row['user_id'])
        archived = bool(row['deleted_at'] or row['user_id'] in archived_students)
        # Truncation only affects a derived label; original course names remain intact.
        label = name(courses[row['course_id']]['course_name'])
        while len((label + '课时包').encode('utf-16-le')) // 2 > 80:
            label = label[:-1]
        add('lesson_packages', {'id': pid, 'organization_id': target_org, 'student_id': sid, 'name': label + '课时包',
                                'status': 'ARCHIVED' if archived else 'ACTIVE', 'created_at': timestamp, 'updated_at': timestamp})
        add('lesson_package_courses', {'organization_id': target_org, 'lesson_package_id': pid,
                                       'course_id': stable('course', row['course_id']), 'created_at': timestamp})
        add('legacy_openings', {'lesson_package_id': pid, 'organization_id': target_org, 'student_id': sid, 'import_id': import_id,
                               'source_enrollment_id': row['id'], 'source_total': total, 'paid_hours': balance, 'gift_hours': 0,
                               'snapshot_at': timestamp, 'allocation_note': ALLOCATION})
        expected.append({'source_enrollment_id': row['id'], 'package_id': pid, 'student_id': sid, 'name': users[row['user_id']]['nick_name'],
                         'status': 'ARCHIVED' if archived else 'ACTIVE', 'paid_balance': balance, 'gift_balance': 0})
    eligible_by_id = {r['id']: r for r in eligible}
    history, zeros = [], []
    for row in data['edu_class_session']:
        if row['enrollment_id'] not in enrollments:
            raise ValueError(f'History without enrollment: {row["id"]}')
        if row['enrollment_id'] not in eligible_by_id:
            continue
        enrollment = eligible_by_id[row['enrollment_id']]
        hours = integer(row['num_sessions'], f'history/{row["id"]}', 0)
        if row['action'] not in ('add', 'subtract') or not row['created_at']:
            raise ValueError(f'Invalid history: {row["id"]}')
        if hours == 0:
            zeros.append(row['id'])
        item = {'id': stable('history', row['id']), 'organization_id': target_org, 'student_id': stable('student', enrollment['user_id']),
                'lesson_package_id': stable('package', enrollment['id']), 'import_id': import_id, 'source_record_id': row['id'],
                'action': row['action'], 'hours': hours, 'course_name': row['course_name'], 'remark': row['reason'],
                'source_created_at': row['created_at'], 'use_date': row['use_date'], 'deleted_at': row['deleted_at']}
        add('legacy_history', item)
        history.append(item)
    summary = {'organization_name': target_name, 'organization_id': target_org, 'courses': len(course_rows), 'students': len(student_ids),
               'active_students': len(student_ids - archived_students), 'archived_students': len(archived_students), 'packages': len(expected),
               'balance_total': sum(r['paid_balance'] for r in expected),
               'balance_active': sum(r['paid_balance'] for r in expected if r['status'] == 'ACTIVE'),
               'balance_archived': sum(r['paid_balance'] for r in expected if r['status'] == 'ARCHIVED'),
               'history_records': len(history), 'zero_history_ids': zeros, 'quarantined_enrollments': len(quarantine),
               'quarantined_hours': sum(x['enrollment']['remaining_sessions'] for x in quarantine),
               'quarantined_history': sum(len(x['history']) for x in quarantine)}
    return {'version': 1, 'source': SOURCE, 'import_id': import_id, 'snapshot_hash': snapshot_hash, 'snapshot_at': timestamp,
            'target_org': target_org, 'target_name': target_name, 'statements': statements, 'expected': expected,
            'history': history, 'quarantine': quarantine, 'summary': summary}


def apply_plan(db, plan):
    """One local transaction; a repeated snapshot never resets balances after new business."""
    with db:
        existing = db.execute('SELECT snapshot_hash, organization_id FROM legacy_imports WHERE id = ?', (plan['import_id'],)).fetchone()
        if existing:
            if tuple(existing) != (plan['snapshot_hash'], plan['target_org']):
                raise ValueError('Different snapshot already imported; refusing overwrite')
            if db.execute('SELECT name FROM organizations WHERE id=?', (plan['target_org'],)).fetchone()[0] != plan['target_name']:
                raise ValueError('Target organization name changed; explicit review required')
            expected_openings = len(plan['expected'])
            expected_history = len(plan['history'])
            actual = db.execute('SELECT COUNT(*) FROM legacy_openings WHERE import_id = ?', (plan['import_id'],)).fetchone()[0]
            actual_history = db.execute('SELECT COUNT(*) FROM legacy_history WHERE import_id = ?', (plan['import_id'],)).fetchone()[0]
            if (actual, actual_history) != (expected_openings, expected_history):
                raise ValueError('Incomplete existing import; manual recovery required')
            return False
        if db.execute('SELECT 1 FROM organizations WHERE id = ? OR name = ?', (plan['target_org'], plan['target_name'])).fetchone():
            raise ValueError('Target organization already exists; explicit review required')
        for statement in plan['statements']:
            db.execute(statement['sql'], statement['params'])
    return True


def verify(db, plan):
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
        raise ValueError('Database integrity check failed')
    reconciliation = []
    for expected in plan['expected']:
        actual = db.execute('SELECT paid_balance, gift_balance, status, student_id, organization_id FROM lesson_packages WHERE id=?', (expected['package_id'],)).fetchone()
        wanted = (expected['paid_balance'], expected['gift_balance'], expected['status'], expected['student_id'], plan['target_org'])
        if tuple(actual or ()) != wanted:
            raise ValueError(f'Balance/ownership mismatch: {expected["source_enrollment_id"]}')
        reconciliation.append({**expected, 'verified': True})
    for item in plan['history']:
        cols = list(item)
        actual = db.execute('SELECT ' + ','.join(cols) + ' FROM legacy_history WHERE id=?', (item['id'],)).fetchone()
        if tuple(actual or ()) != tuple(item.values()):
            raise ValueError(f'History changed: {item["source_record_id"]}')
    if db.execute('SELECT COUNT(*) FROM lesson_records WHERE organization_id=?', (plan['target_org'],)).fetchone()[0]:
        raise ValueError('Legacy history incorrectly replayed into new ledger')
    return reconciliation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Must not already exist')
    parser.add_argument('--source-org', type=int, required=True)
    parser.add_argument('--target-name', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    plan = build_plan(args.snapshot, args.source_org, args.target_name)
    args.output.mkdir(parents=True, exist_ok=False)
    db = sqlite3.connect(args.output / 'trial.sqlite3')
    db.execute('PRAGMA foreign_keys=ON')
    try:
        for migration in sorted((ROOT / 'migrations').glob('*.sql')):
            db.executescript(migration.read_text())
        if not apply_plan(db, plan):
            raise ValueError('Fresh trial was not imported')
        reconciled = verify(db, plan)
        before = list(db.iterdump())
        if apply_plan(db, plan) or list(db.iterdump()) != before:
            raise ValueError('Repeated import changed data')
    finally:
        db.close()
    result = {**plan['summary'], 'all_balances_verified': True, 'all_history_fields_verified': True, 'repeated_import_unchanged': True}
    for filename, value in [('plan.json', plan), ('summary.json', result), ('reconciliation.json', reconciled), ('quarantine.json', plan['quarantine'])]:
        (args.output / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
