"""Keep the offline GitHub fixture strict while testing file-based JSON input."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

FIXTURE = Path(__file__).parent / "fixtures/github_cli_stub.py"
ENVIRONMENT = "repos/irfanozer/field-merge/environments/aws-production"
BODY = {
    "deployment_branch_policy": {
        "protected_branches": False,
        "custom_branch_policies": True,
    }
}


class GitHubJsonInputTests(unittest.TestCase):
    def assert_rejected(self, payload: bytes, diagnostic: str) -> None:
        with tempfile.TemporaryDirectory(prefix="github JSON fixture ") as temp:
            directory = Path(temp)
            request = directory / "request with spaces.json"
            request.write_bytes(payload)
            environment = os.environ.copy()
            environment.update(
                FIELDMERGE_GITHUB_TEST_CASE="missing",
                FIELDMERGE_GITHUB_TEST_LOG=str(directory / "calls.jsonl"),
                PYTHONIOENCODING="utf-8",
                PYTHONUTF8="1",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(FIXTURE),
                    "gh",
                    "api",
                    "--method",
                    "PUT",
                    ENVIRONMENT,
                    "--input",
                    str(request),
                ],
                env=environment,
                capture_output=True,
                encoding="utf-8",
                timeout=10,
                check=False,
            )
        self.assertEqual(result.returncode, 97, result.stdout + result.stderr)
        self.assertIn("OFFLINE-FIXTURE-REJECTED", result.stderr)
        self.assertIn(diagnostic, result.stderr)

    def test_bom_is_rejected_instead_of_silently_removed(self) -> None:
        self.assert_rejected(
            b"\xef\xbb\xbf" + json.dumps(BODY).encode("utf-8"), "Unexpected UTF-8 BOM"
        )

    def test_wrong_branch_protection_is_rejected(self) -> None:
        self.assert_rejected(
            b'{"deployment_branch_policy": null}', "exactly the selected-branch policy"
        )


if __name__ == "__main__":
    unittest.main()
