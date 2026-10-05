#!/usr/bin/env python3
"""No-provider tests of quality harness fail-closed acceptance."""
import copy
import unittest
from unittest.mock import patch
from quality_browser import assert_record, main


class QualityAcceptance(unittest.TestCase):
    def ready(self):
        return {'draft':{'phase':'ready'},'pageErrors':[],'hostErrors':[],
                'walkthroughNavigation':{'requiredSteps':3,'checkedSteps':3,'noNewProviderCalls':True,'sameAcceptedClaims':True},
                'reopen':{'noNewProviderCalls':True,'sameClaims':True}}

    def test_finite_blocker_is_not_a_completed_tutorial(self):
        assert_record({'draft':{'phase':'blocked'},'pageErrors':[],'hostErrors':[]})
        assert_record(self.ready())

    def test_each_failed_workflow_check_fails_acceptance(self):
        mutations=[lambda r:r.update(runError='Assertion failed'), lambda r:r['pageErrors'].append('Renderer threw'),
            lambda r:r['hostErrors'].append('Host threw'), lambda r:r['draft'].update(phase='challenging'),
            lambda r:r['walkthroughNavigation'].update(checkedSteps=2), lambda r:r['walkthroughNavigation'].update(noNewProviderCalls=False),
            lambda r:r['walkthroughNavigation'].update(sameAcceptedClaims=False),lambda r:r['reopen'].update(noNewProviderCalls=False), lambda r:r['reopen'].update(sameClaims=False)]
        for mutate in mutations:
            result=copy.deepcopy(self.ready());mutate(result)
            with self.assertRaises(AssertionError):assert_record(result)

    def test_failed_case_changes_command_exit_status(self):
        with patch('sys.argv',['quality_browser.py','--cases','d3','--provider','none','--output','unused']),patch('quality_browser.run_case',return_value=False):
            with self.assertRaises(SystemExit) as failure:main()
            self.assertEqual(failure.exception.code,1)


if __name__=='__main__':unittest.main()
