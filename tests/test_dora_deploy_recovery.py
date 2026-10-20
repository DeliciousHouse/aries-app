"""Offline controller safety checks. No claim of host/provider acceptance."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('controller', Path(__file__).parents[1] / 'scripts/release/dora_pull_deploy.py')
assert SPEC is not None and SPEC.loader is not None
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class RecoveryTests(unittest.TestCase):
    def test_protects_crash_journal_fails_when_health_resumes_no_claim_live_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            journal = {'sha': 'a' * 40, 'originals': {n: n + '-original' for n in controller.SERVICES}}
            (state / 'transaction.json').write_text(json.dumps(journal))
            with patch.object(controller, 'inspect', return_value=None), patch.object(controller, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'unresolved'):
                    controller.finish_or_recover(state)
                run.assert_not_called()
            self.assertTrue((state / 'transaction.json').exists())
            self.assertFalse((state / 'deployed').exists())

    def test_protects_originals_fails_when_restart_or_delete_no_claim_rollback_compatibility(self):
        journal = {'sha': 'a' * 40, 'originals': {n: n + '-original' for n in controller.SERVICES}}
        with patch.object(controller, 'inspect', side_effect=lambda n: {'Id': journal['originals'][n], 'State': {'Running': False}}), patch.object(controller, 'run') as run:
            controller.rollback(journal)
            run.assert_not_called()

    def test_protects_exact_candidate_stop_fails_when_readback_running_no_claim_external_outcome(self):
        name = controller.SERVICES[0]
        journal = {'sha': 'a' * 40, 'originals': {name: 'original'}, 'candidates': {name: 'candidate'}}
        with patch.object(controller, 'inspect', return_value={'Id': 'candidate', 'State': {'Running': True}}), patch.object(controller, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'stop unverified'):
                controller.rollback(journal)
            self.assertEqual(run.call_args_list[0].args, ('docker', 'stop', '-t', '360', 'candidate'))
            self.assertEqual(run.call_count, 1)

    def test_protects_unknown_candidate_fails_when_stopping_unbound_id_no_claim_containment(self):
        name = controller.SERVICES[0]
        journal = {'sha': 'a' * 40, 'originals': {name: 'original'}}
        with patch.object(controller, 'inspect', return_value={'Id': 'unknown', 'State': {'Running': True}}), patch.object(controller, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'identity unresolved'):
                controller.rollback(journal)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
