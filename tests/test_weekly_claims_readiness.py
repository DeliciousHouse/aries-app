"""Run with pg_virtualenv python3 tests/test_weekly_claims_readiness.py.
Disposable PostgreSQL only; no claim of production/restored-copy acceptance.
"""
from pathlib import Path
import os
import re
import subprocess
import unittest


@unittest.skipUnless(os.environ.get('PG_CLUSTER_CONF_ROOT'), 'requires disposable pg_virtualenv cluster')
class ReadinessTests(unittest.TestCase):
    def test_protects_real_constraints_fails_when_missing_or_incompatible_no_claim_production(self):
        source = (Path(__file__).parents[1] / 'scripts/automations/weekly-job-trigger-worker.ts').read_text()
        match = re.search(r'export const CLAIMS_READINESS_SQL = `([^`]+)`;', source)
        assert match
        probe = match.group(1) + ';'
        sql = '''BEGIN;
CREATE SCHEMA readiness_fixture;
SET LOCAL search_path TO readiness_fixture, pg_catalog;
CREATE TABLE organizations(id integer PRIMARY KEY);
'''
        sql += probe
        sql += '''CREATE TABLE marketing_weekly_claims(
 tenant_id integer PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 claimed_at timestamptz NOT NULL DEFAULT now(), prior_last_triggered_at timestamptz);
'''
        sql += probe
        sql += 'ALTER TABLE marketing_weekly_claims DROP CONSTRAINT marketing_weekly_claims_tenant_id_fkey;'
        sql += probe
        sql += 'ROLLBACK;'
        result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['f', 't', 'f'])


if __name__ == '__main__':
    unittest.main()
