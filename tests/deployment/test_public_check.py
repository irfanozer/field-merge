"""Offline public-entrypoint checks using in-memory HTTP responses only."""

from __future__ import annotations

import copy
import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[2]
PREVIEW = "https://preview.example.com"


class PublicCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "fieldmerge_public_check", ROOT / "scripts/aws/check-public.py"
        )
        cls.check = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.check)

    def setUp(self):
        self.visited = []
        self.pages = {
            "/": {
                "headers": {
                    "content-type": "text/html",
                    "x-content-type-options": "nosniff",
                    "x-frame-options": "DENY",
                    "referrer-policy": "strict-origin-when-cross-origin",
                    "content-security-policy": (
                        "default-src 'self'; frame-ancestors 'none'; connect-src 'self' wss:"
                    ),
                    "strict-transport-security": "max-age=31536000; includeSubDomains",
                    "permissions-policy": "camera=(), microphone=(), geolocation=()",
                },
                "text": "<!doctype html><title>FieldMerge</title>",
            },
            "/healthz": {
                "headers": {"content-type": "text/plain", "cache-control": "no-store"},
                "text": "healthy",
            },
            "/health/ready": {
                "headers": {
                    "content-type": "application/json",
                    "cache-control": "no-store",
                },
                "json": {"status": "ok", "service": "fieldmerge-backend"},
            },
            "/api/v1/documents/inspection-pump-07": {
                "headers": {
                    "content-type": "application/json",
                    "cache-control": "no-store",
                },
                "json": {
                    "document_id": "inspection-pump-07",
                    "state_digest": "fixture",
                },
            },
        }

    def client(self):
        def respond(request):
            self.assertEqual(request.url.host, "preview.example.com")
            self.visited.append(request.url.path)
            return httpx.Response(200, **self.pages[request.url.path])

        return httpx.Client(base_url=PREVIEW, transport=httpx.MockTransport(respond))

    def test_healthy_public_entrypoints_are_all_checked(self):
        with self.client() as client:
            self.check.check_entrypoints(client)
        self.assertEqual(self.visited, list(self.pages))

    def test_url_validation_rejects_unsafe_remote_http_and_non_origin_inputs(self):
        for target in (
            "",
            "preview.example.com",
            "http://preview.example.com",
            "ftp://preview.example.com",
            "https://user:password@preview.example.com",
            "https://preview.example.com/path",
            "https://preview.example.com/?query=value",
            "https://preview.example.com/#fragment",
        ):
            with (
                self.subTest(url=target),
                patch.dict(os.environ, {"FIELDMERGE_SMOKE_URL": target}),
                self.assertRaises(RuntimeError),
            ):
                self.check.base_url()
        for target in (PREVIEW, "http://127.0.0.1:18080", "http://localhost:18080"):
            with (
                self.subTest(url=target),
                patch.dict(os.environ, {"FIELDMERGE_SMOKE_URL": target + "/"}),
            ):
                self.assertEqual(self.check.base_url(), target)

    def test_missing_websocket_csp_is_rejected(self):
        self.pages["/"]["headers"]["content-security-policy"] = (
            "default-src 'self'; frame-ancestors 'none'"
        )
        with self.client() as client, self.assertRaisesRegex(RuntimeError, "wss:"):
            self.check.check_entrypoints(client)

    def test_missing_browser_protections_are_rejected(self):
        healthy = copy.deepcopy(self.pages["/"]["headers"])
        for header in healthy:
            with self.subTest(header=header):
                self.pages["/"]["headers"] = {
                    key: value for key, value in healthy.items() if key != header
                }
                with self.client() as client, self.assertRaises(RuntimeError):
                    self.check.check_entrypoints(client)

    def test_cached_or_cacheable_dynamic_responses_are_rejected(self):
        for path in list(self.pages)[1:]:
            healthy = copy.deepcopy(self.pages[path]["headers"])
            for changes in (
                {"cache-control": "public, max-age=60"},
                {"x-cache": "Hit from cloudfront"},
                {"age": "60"},
            ):
                with self.subTest(path=path, headers=changes):
                    self.pages[path]["headers"] = {**healthy, **changes}
                    with (
                        self.client() as client,
                        self.assertRaisesRegex(RuntimeError, "cach"),
                    ):
                        self.check.check_entrypoints(client)
            self.pages[path]["headers"] = healthy

    def test_html_fallback_must_not_mask_api_or_readiness_errors(self):
        for path in ("/health/ready", "/api/v1/documents/inspection-pump-07"):
            healthy = self.pages[path]
            with self.subTest(path=path):
                self.pages[path] = {
                    "headers": {
                        "content-type": "text/html",
                        "cache-control": "no-store",
                    },
                    "text": "<!doctype html><title>FieldMerge</title>",
                }
                with (
                    self.client() as client,
                    self.assertRaisesRegex(RuntimeError, "frontend page"),
                ):
                    self.check.check_entrypoints(client)
                self.pages[path] = healthy

    def test_success_runs_the_existing_database_and_websocket_smoke_once(self):
        fixture_client = self.client()
        with (
            patch.dict(os.environ, {"FIELDMERGE_SMOKE_URL": PREVIEW + "/"}),
            patch.object(self.check.httpx, "Client", return_value=fixture_client),
            patch.object(self.check.subprocess, "run") as smoke,
            patch("builtins.print"),
        ):
            self.check.main()
        smoke.assert_called_once()
        self.assertEqual(Path(smoke.call_args.args[0][-1]), ROOT / "scripts/smoke.py")
        self.assertEqual(smoke.call_args.kwargs["env"]["FIELDMERGE_SMOKE_URL"], PREVIEW)
        self.assertIs(smoke.call_args.kwargs["check"], True)

    def test_live_smoke_failure_is_not_reported_as_success(self):
        fixture_client = self.client()
        with (
            patch.dict(os.environ, {"FIELDMERGE_SMOKE_URL": PREVIEW}),
            patch.object(self.check.httpx, "Client", return_value=fixture_client),
            patch.object(
                self.check.subprocess,
                "run",
                side_effect=subprocess.CalledProcessError(1, "fixture"),
            ),
            patch("builtins.print") as output,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            self.check.main()
        self.assertNotIn(
            "FieldMerge public deployment checks passed.",
            [call.args[0] for call in output.call_args_list],
        )


if __name__ == "__main__":
    unittest.main()
