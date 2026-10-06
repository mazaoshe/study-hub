import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studyhub_trial import ROOT, TABLES, apply_plan, build_plan, stable, verify


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.snapshot = Path(self.tmp.name)
        (self.snapshot / 'tables').mkdir()
        data = {
            'edu_organization': [{'id': 1, 'deleted_at': None}, {'id': 2, 'deleted_at': None}],
            'edu_course': [dict(id=i, organization_id=i, course_name=f'课程{i}', description='', deleted_at=None) for i in [1, 2]],
            'sys_users': [dict(id=i, edu_organization_id=2 if i == 3 else 1, nick_name=f'学员{i}', phone='', authority_id=222,
                               enable=1, deleted_at='2020-01-01' if i == 2 else None) for i in [1, 2, 3]],
            'edu_enrollment': [dict(id=i, user_id=i, course_id=2 if i == 3 else 1, total_sessions=20,
                                    remaining_sessions=i + 5, deleted_at=None) for i in [1, 2, 3, 4]],
            'edu_class_session': [dict(id=i, enrollment_id=i, num_sessions=0 if i == 1 else 3, action='add',
                                       course_name='历史旧课程', reason=None, created_at='2020-01-01T08:30:00',
                                       use_date=None, deleted_at=None) for i in [1, 2, 3, 4]],
            'sys_user_authority': []
        }
        hashes = {}
        for table in TABLES:
            p = self.snapshot / 'tables' / (table + '.json')
            p.write_text(json.dumps(data[table]))
            hashes[f'tables/{table}.json'] = hashlib.sha256(p.read_bytes()).hexdigest()
        (self.snapshot / 'manifest.json').write_text(json.dumps({'status': 'complete', 'source_database': 'study-hub',
            'sha256': hashes, 'exported_at': '2026-10-02T13:16:06+08:00'}))
        self.plan = build_plan(self.snapshot, 1, '试导入机构')
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA foreign_keys=ON')
        for f in sorted((ROOT / 'migrations').glob('*.sql')):
            self.db.executescript(f.read_text())

    def test_scope_archives_orphans_and_zero_history(self):
        self.assertTrue(apply_plan(self.db, self.plan))
        self.assertEqual(len(verify(self.db, self.plan)), 2)
        self.assertEqual(self.plan['summary']['students'], 2)
        self.assertEqual(self.plan['summary']['archived_students'], 1)
        self.assertEqual(self.plan['summary']['history_records'], 2)
        self.assertEqual(self.plan['summary']['quarantined_enrollments'], 1)
        self.assertEqual(self.plan['summary']['quarantined_history'], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM lesson_records').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT hours, use_date, course_name FROM legacy_history WHERE source_record_id=1').fetchone(), (0, None, '历史旧课程'))

    def test_retry_does_not_reset_balance_after_new_business(self):
        apply_plan(self.db, self.plan)
        org = self.plan['target_org']
        self.db.execute("INSERT INTO users VALUES ('actor','test-only','ORG_ADMIN',?,'ACTIVE','now','now')", (org,))
        self.db.execute("INSERT INTO lesson_records (id,organization_id,student_id,lesson_package_id,course_id,type,paid_change,gift_change,request_id,operator_id,created_at) VALUES ('new',?,?,?,?,'CONSUME',-1,0,'new','actor','now')", (org, stable('student',1), stable('package',1), stable('course',1)))
        self.db.commit()
        before = list(self.db.iterdump())
        self.assertFalse(apply_plan(self.db, self.plan))
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute('SELECT paid_balance FROM lesson_packages WHERE id=?', (stable('package',1),)).fetchone()[0], 5)

    def test_different_snapshot_refuses_overwrite(self):
        apply_plan(self.db, self.plan)
        changed = {**self.plan, 'snapshot_hash': 'different'}
        with self.assertRaisesRegex(ValueError, 'Different snapshot'):
            apply_plan(self.db, changed)

    def test_failed_import_rolls_back_every_row_and_preserves_existing_org(self):
        self.db.execute("INSERT INTO organizations VALUES ('existing','已有机构','ACTIVE','now','now')")
        self.db.commit()
        broken = copy.deepcopy(self.plan)
        broken['statements'].append({'sql': 'INSERT INTO students (id) VALUES (?)', 'params': ['bad']})
        with self.assertRaises(sqlite3.IntegrityError):
            apply_plan(self.db, broken)
        self.assertEqual(self.db.execute('SELECT id FROM organizations').fetchall(), [('existing',)])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM legacy_imports').fetchone()[0], 0)

    def test_snapshot_tampering_fails_before_import(self):
        with (self.snapshot / 'tables/edu_course.json').open('a') as f:
            f.write(' ')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            build_plan(self.snapshot, 1, '试导入机构')

    def test_opening_and_history_are_immutable(self):
        apply_plan(self.db, self.plan)
        for sql in ['UPDATE legacy_openings SET paid_hours=0', 'DELETE FROM legacy_openings', 'DELETE FROM legacy_history', 'UPDATE legacy_history SET hours=10']:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'LEGACY_APPEND_ONLY'):
                self.db.execute(sql)


if __name__ == '__main__':
    unittest.main()
