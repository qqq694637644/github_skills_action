from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from skill_temple.app import create_app


class WorkspaceActionsTests(unittest.TestCase):
    def _client(self, root: Path, operation_root: Path | None = None) -> TestClient:
        environment = {
            "WORKSPACE_ROOT": str(root),
            "WORKSPACE_OPERATION_ROOT": str(operation_root or (root / ".operations")),
        }
        self.environment_patch = patch.dict(os.environ, environment, clear=False)
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)
        return TestClient(create_app())

    @staticmethod
    def _prepare_workspace(client: TestClient, key: str) -> str:
        response = client.post(
            "/v1/workspace/prepare",
            json={"idempotency_key": key},
        )
        if response.status_code != 200:
            raise AssertionError(response.text)
        return str(response.json()["workspace_id"])

    def test_openapi_exposes_all_workspace_operations(self) -> None:
        schema = create_app().openapi()
        expected = {
            "prepareWorkspace",
            "workspaceCommand",
            "workspaceInspect",
            "workspaceSearch",
            "workspaceReadFiles",
            "workspaceWriteFile",
            "workspaceApplyPatch",
        }
        found = {
            operation["operationId"]
            for path, path_item in schema["paths"].items()
            if path.startswith("/v1/workspace/")
            for operation in path_item.values()
        }
        self.assertEqual(found, expected)
        for path, path_item in schema["paths"].items():
            if not path.startswith("/v1/workspace/"):
                continue
            for operation in path_item.values():
                self.assertIs(operation["x-openai-isConsequential"], False)
                self.assertLessEqual(len(operation.get("description", "")), 300)

    def test_missing_workspace_root_is_structured(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            client = TestClient(create_app())
            response = client.post(
                "/v1/workspace/read-files",
                json={"workspace_id": "ws_0000000000000000", "paths": ["a.txt"]},
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json()["detail"]["error"]["code"],
            "WORKSPACE_ROOT_NOT_CONFIGURED",
        )

    def test_prepare_workspace_is_idempotent_and_multiple_workspaces_are_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self._client(root)
            first = client.post(
                "/v1/workspace/prepare",
                json={"idempotency_key": "workspace-one-key"},
            )
            repeat = client.post(
                "/v1/workspace/prepare",
                json={"idempotency_key": "workspace-one-key"},
            )
            second = client.post(
                "/v1/workspace/prepare",
                json={"idempotency_key": "workspace-two-key"},
            )
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(repeat.status_code, 200, repeat.text)
            self.assertEqual(second.status_code, 200, second.text)
            first_id = first.json()["workspace_id"]
            second_id = second.json()["workspace_id"]
            self.assertEqual(first_id, repeat.json()["workspace_id"])
            self.assertTrue(first.json()["created"])
            self.assertFalse(repeat.json()["created"])
            self.assertNotEqual(first_id, second_id)

            written = client.post(
                "/v1/workspace/write-file",
                json={
                    "workspace_id": first_id,
                    "path": "marker.txt",
                    "content": "one",
                },
            )
            self.assertEqual(written.status_code, 200, written.text)
            missing = client.post(
                "/v1/workspace/read-files",
                json={"workspace_id": second_id, "paths": ["marker.txt"]},
            )
            self.assertIn("not found", missing.json()["files"][0]["error"])

            reused = client.post(
                "/v1/workspace/prepare",
                json={"workspace_id": first_id},
            )
            self.assertEqual(reused.status_code, 200, reused.text)
            self.assertFalse(reused.json()["created"])
            self.assertFalse(reused.json()["empty"])

    def test_read_files_returns_numbered_utf8_content_and_truncation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self._client(root)
            workspace_id = self._prepare_workspace(client, "read-files-workspace")
            workspace_root = root / workspace_id
            (workspace_root / "alpha.txt").write_text("一\ntwo\nthree\n", encoding="utf-8")
            response = client.post(
                "/v1/workspace/read-files",
                json={
                    "workspace_id": workspace_id,
                    "paths": ["alpha.txt", "missing.txt"],
                    "start_line": 2,
                    "max_lines": 1,
                },
            )
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["files"][0]["content"], "2: two")
            self.assertTrue(body["files"][0]["truncated"])
            self.assertEqual(body["files"][0]["total_lines"], 3)
            self.assertEqual(
                body["files"][0]["sha256"],
                hashlib.sha256((workspace_root / "alpha.txt").read_bytes()).hexdigest(),
            )
            self.assertIn("not found", body["files"][1]["error"])

    @unittest.skipUnless(shutil.which("rg"), "ripgrep is required")
    def test_search_and_inspect_match_gateway_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self._client(root)
            workspace_id = self._prepare_workspace(client, "search-inspect-workspace")
            workspace_root = root / workspace_id
            (workspace_root / "src").mkdir()
            (workspace_root / "src" / "alpha.py").write_text(
                "first\nNeedle value\nlast\n", encoding="utf-8"
            )
            search = client.post(
                "/v1/workspace/search",
                json={
                    "workspace_id": workspace_id,
                    "query": "needle",
                    "paths": ["src"],
                    "case_sensitive": False,
                    "context_lines": 1,
                    "max_matches": 10,
                },
            )
            self.assertEqual(search.status_code, 200, search.text)
            match = search.json()["matches"][0]
            self.assertEqual(match["path"], "src/alpha.py")
            self.assertEqual(match["line_number"], 2)
            self.assertIn("2: Needle value", match["snippet"])

            inspect = client.post(
                "/v1/workspace/inspect",
                json={
                    "workspace_id": workspace_id,
                    "paths": ["src"],
                    "queries": ["Needle"],
                    "max_depth": 3,
                    "max_read_files": 2,
                },
            )
            self.assertEqual(inspect.status_code, 200, inspect.text)
            body = inspect.json()
            self.assertTrue(any(item["path"] == "src/alpha.py" for item in body["tree"]))
            self.assertEqual(body["searches"][0]["match_count"], 1)
            self.assertEqual(body["files"][0]["path"], "src/alpha.py")

    def test_write_file_modes_hash_line_endings_and_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self._client(root)
            workspace_id = self._prepare_workspace(client, "write-file-workspace")
            workspace_root = root / workspace_id
            created = client.post(
                "/v1/workspace/write-file",
                json={
                    "workspace_id": workspace_id,
                    "path": "nested/a.txt",
                    "content": "one\ntwo\n",
                    "mode": "create_only",
                    "line_ending": "crlf",
                },
            )
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual((workspace_root / "nested" / "a.txt").read_bytes(), b"one\r\ntwo\r\n")
            current_sha = created.json()["new_sha256"]

            duplicate = client.post(
                "/v1/workspace/write-file",
                json={
                    "workspace_id": workspace_id,
                    "path": "nested/a.txt",
                    "content": "x",
                    "mode": "create_only",
                },
            )
            self.assertEqual(duplicate.status_code, 409)

            mismatch = client.post(
                "/v1/workspace/write-file",
                json={
                    "workspace_id": workspace_id,
                    "path": "nested/a.txt",
                    "content": "changed",
                    "mode": "overwrite_if_sha256_matches",
                    "expected_sha256": "0" * 64,
                },
            )
            self.assertEqual(mismatch.status_code, 409)

            updated = client.post(
                "/v1/workspace/write-file",
                json={
                    "workspace_id": workspace_id,
                    "path": "nested/a.txt",
                    "content": "changed\n",
                    "mode": "overwrite_if_sha256_matches",
                    "expected_sha256": current_sha,
                    "line_ending": "lf",
                    "dry_run": True,
                },
            )
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertFalse(updated.json()["written"])
            self.assertEqual((workspace_root / "nested" / "a.txt").read_bytes(), b"one\r\ntwo\r\n")

    def test_apply_patch_add_update_delete_dry_run_and_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            client = self._client(root)
            workspace_id = self._prepare_workspace(client, "patch-workspace")
            workspace_root = root / workspace_id
            (workspace_root / "alpha.txt").write_text("one\ntwo\n", encoding="utf-8")
            patch_text = """*** Begin Patch
*** Update File: alpha.txt
@@
-one
+ONE
 two
*** Add File: beta.txt
+hello
*** End Patch
"""
            dry_run = client.post(
                "/v1/workspace/apply-patch",
                json={"workspace_id": workspace_id, "patch": patch_text, "dry_run": True},
            )
            self.assertEqual(dry_run.status_code, 200, dry_run.text)
            self.assertFalse(dry_run.json()["applied"])
            self.assertEqual(
                (workspace_root / "alpha.txt").read_text(encoding="utf-8"), "one\ntwo\n"
            )
            self.assertFalse((workspace_root / "beta.txt").exists())

            applied = client.post(
                "/v1/workspace/apply-patch",
                json={"workspace_id": workspace_id, "patch": patch_text},
            )
            self.assertEqual(applied.status_code, 200, applied.text)
            self.assertEqual(
                (workspace_root / "alpha.txt").read_text(encoding="utf-8"), "ONE\ntwo\n"
            )
            self.assertEqual((workspace_root / "beta.txt").read_text(encoding="utf-8"), "hello\n")

            rollback_patch = """*** Begin Patch
*** Update File: alpha.txt
@@
-ONE
+CHANGED
*** Update File: alpha.txt
@@
-missing
+value
*** End Patch
"""
            failed = client.post(
                "/v1/workspace/apply-patch",
                json={"workspace_id": workspace_id, "patch": rollback_patch},
            )
            self.assertEqual(failed.status_code, 409)
            self.assertEqual(
                (workspace_root / "alpha.txt").read_text(encoding="utf-8"), "ONE\ntwo\n"
            )

            deleted = client.post(
                "/v1/workspace/apply-patch",
                json={
                    "workspace_id": workspace_id,
                    "patch": "*** Begin Patch\n*** Delete File: beta.txt\n*** End Patch\n",
                    "allow_delete": True,
                },
            )
            self.assertEqual(deleted.status_code, 200, deleted.text)
            self.assertFalse((workspace_root / "beta.txt").exists())

    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell 7 is required")
    def test_command_start_get_logs_list_timeout_and_cancel(self) -> None:
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as operations:
            root = Path(temp)
            with self._client(root, Path(operations)) as client:
                workspace_id = self._prepare_workspace(client, "command-workspace")
                started = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "start",
                        "idempotency_key": "command-success-1",
                        "workspace_id": workspace_id,
                        "script": "Write-Output 'hello'; [Console]::Error.WriteLine('oops')",
                        "timeout_seconds": 20,
                        "plain_output": True,
                    },
                )
                self.assertEqual(started.status_code, 200, started.text)
                operation_id = started.json()["operation"]["operation_id"]
                terminal = self._poll_operation(client, operation_id)
                self.assertEqual(terminal["state"], "succeeded")

                first_logs = client.post(
                    "/v1/workspace/command",
                    json={"action": "logs", "operation_id": operation_id, "max_bytes": 3},
                ).json()
                self.assertEqual(first_logs["stdout"], "hel")
                second_logs = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "logs",
                        "operation_id": operation_id,
                        "stdout_offset": first_logs["next_stdout_offset"],
                        "stderr_offset": first_logs["next_stderr_offset"],
                        "max_bytes": 100,
                    },
                ).json()
                self.assertIn("lo", second_logs["stdout"])
                self.assertTrue(second_logs["stdout_eof"])

                with patch.dict(os.environ, {"GH_TOKEN": "workspace-test-token"}, clear=False):
                    raw_shell = client.post(
                        "/v1/workspace/command",
                        json={
                            "action": "start",
                            "idempotency_key": "command-raw-shell-1",
                            "workspace_id": workspace_id,
                            "script": (
                                "Get-ChildItem Env:GH_TOKEN | Out-Null; "
                                "Write-Output $env:GH_TOKEN"
                            ),
                            "timeout_seconds": 20,
                            "plain_output": True,
                        },
                    )
                    self.assertEqual(raw_shell.status_code, 200, raw_shell.text)
                    raw_id = raw_shell.json()["operation"]["operation_id"]
                    self.assertEqual(self._poll_operation(client, raw_id)["state"], "succeeded")
                    raw_logs = client.post(
                        "/v1/workspace/command",
                        json={"action": "logs", "operation_id": raw_id},
                    ).json()
                    self.assertIn("workspace-test-token", raw_logs["stdout"])

                listed = client.post(
                    "/v1/workspace/command", json={"action": "list", "state": "succeeded"}
                )
                self.assertTrue(
                    any(
                        item["operation_id"] == operation_id
                        for item in listed.json()["operations"]
                    )
                )

                timeout = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "start",
                        "idempotency_key": "command-timeout-1",
                        "workspace_id": workspace_id,
                        "script": "Start-Sleep -Seconds 5",
                        "timeout_seconds": 1,
                    },
                )
                timeout_id = timeout.json()["operation"]["operation_id"]
                self.assertEqual(self._poll_operation(client, timeout_id)["state"], "timed_out")

                cancel = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "start",
                        "idempotency_key": "command-cancel-1",
                        "workspace_id": workspace_id,
                        "script": "Start-Sleep -Seconds 10",
                        "timeout_seconds": 20,
                    },
                )
                cancel_id = cancel.json()["operation"]["operation_id"]
                cancel_response = client.post(
                    "/v1/workspace/command",
                    json={"action": "cancel", "operation_id": cancel_id},
                )
                self.assertEqual(cancel_response.status_code, 200)
                self.assertEqual(self._poll_operation(client, cancel_id)["state"], "canceled")

    @unittest.skipUnless(
        shutil.which("pwsh") and shutil.which("git"),
        "PowerShell 7 and git are required",
    )
    def test_same_workspace_persists_repo_and_can_switch_branches(self) -> None:
        with tempfile.TemporaryDirectory() as temp, tempfile.TemporaryDirectory() as operations:
            root = Path(temp)
            with self._client(root, Path(operations)) as client:
                workspace_id = self._prepare_workspace(client, "branch-switch-workspace")
                initialized = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "start",
                        "idempotency_key": "branch-switch-init",
                        "workspace_id": workspace_id,
                        "script": (
                            "git init -b main; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; "
                            "git config user.email test@example.com; "
                            "git config user.name test; "
                            "Set-Content -LiteralPath marker.txt -Value main; "
                            "git add marker.txt; git commit -m init; "
                            "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; "
                            "git switch -c feature/test"
                        ),
                        "timeout_seconds": 30,
                        "plain_output": True,
                    },
                )
                self.assertEqual(initialized.status_code, 200, initialized.text)
                init_id = initialized.json()["operation"]["operation_id"]
                self.assertEqual(self._poll_operation(client, init_id)["state"], "succeeded")

                switched = client.post(
                    "/v1/workspace/command",
                    json={
                        "action": "start",
                        "idempotency_key": "branch-switch-main",
                        "workspace_id": workspace_id,
                        "script": (
                            "git switch main; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; "
                            "git branch --show-current"
                        ),
                        "timeout_seconds": 30,
                        "plain_output": True,
                    },
                )
                self.assertEqual(switched.status_code, 200, switched.text)
                switch_id = switched.json()["operation"]["operation_id"]
                self.assertEqual(self._poll_operation(client, switch_id)["state"], "succeeded")
                logs = client.post(
                    "/v1/workspace/command",
                    json={"action": "logs", "operation_id": switch_id},
                ).json()
                self.assertIn("main", logs["stdout"])

    @staticmethod
    def _poll_operation(client: TestClient, operation_id: str) -> dict[str, object]:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            response = client.post(
                "/v1/workspace/command",
                json={"action": "get", "operation_id": operation_id},
            )
            if response.status_code != 200:
                raise AssertionError(response.text)
            operation = response.json()["operation"]
            if operation["state"] != "running":
                return operation
            time.sleep(0.05)
        raise AssertionError(f"operation did not finish: {operation_id}")


if __name__ == "__main__":
    unittest.main()
