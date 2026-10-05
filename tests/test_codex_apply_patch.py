from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from workspace_mcp.workspace_patch import (
    WorkspaceToolError,
    _windows_path_is_reserved,
    commit_prepared_changes,
    parse_codex_patch,
    prepare_text_patch,
    snapshot_files,
)


def _prepare(root: Path, patch: str, *, allow_delete: bool = False):
    operations = parse_codex_patch(
        patch,
        root,
        allow_delete=allow_delete,
        max_changed_files=20,
    )
    paths: list[str] = []
    for operation in operations:
        paths.append(operation.path)
        if operation.move_path is not None:
            paths.append(operation.move_path)
    snapshots = snapshot_files(root, list(dict.fromkeys(paths)))
    return operations, prepare_text_patch(root, operations, snapshots)


def test_codex_patch_accepts_update_without_explicit_context_marker() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes(b"alpha\nbeta\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            "-beta\n"
            "+gamma\n"
            "*** End Patch",
        )

        assert changes[0].after == b"alpha\ngamma\n"


def test_codex_patch_allows_empty_add_file() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Add File: empty.txt\n"
            "*** End Patch",
        )

        assert operations[0].add_lines == []
        assert changes[0].path == "empty.txt"
        assert changes[0].after == b""


def test_codex_patch_allows_empty_patch() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** End Patch",
        )

        assert operations == []
        assert changes == []


def test_codex_add_state_accepts_indented_next_header() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "delete.txt").write_bytes(b"delete me\n")

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Add File: add.txt\n"
            "+added\n"
            "   *** Delete File: delete.txt\n"
            "*** End Patch",
            allow_delete=True,
        )

        assert [operation.kind for operation in operations] == ["add", "delete"]
        by_path = {change.path: change for change in changes}
        assert by_path["add.txt"].after == b"added\n"
        assert by_path["delete.txt"].after is None


def test_codex_delete_state_accepts_indented_next_header() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "delete.txt").write_bytes(b"delete me\n")

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Delete File: delete.txt\n"
            "   *** Add File: add.txt\n"
            "+added\n"
            "*** End Patch",
            allow_delete=True,
        )

        assert [operation.kind for operation in operations] == ["delete", "add"]
        by_path = {change.path: change for change in changes}
        assert by_path["delete.txt"].after is None
        assert by_path["add.txt"].after == b"added\n"


def test_codex_add_state_rejects_bare_blank_content_line() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        with pytest.raises(WorkspaceToolError) as captured:
            _prepare(
                root,
                "*** Begin Patch\n"
                "*** Add File: a.txt\n"
                "+first\n"
                "\n"
                "+second\n"
                "*** End Patch",
            )

        assert captured.value.code == "WORKSPACE_PATCH_INVALID"
        assert "use '+' to add an empty content line" in captured.value.message


def test_codex_update_state_does_not_trim_leading_header_like_context() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes(
            b"before\n"
            b"*** Add File: not-an-operation.txt\n"
            b"after\n"
        )

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            "@@\n"
            " *** Add File: not-an-operation.txt\n"
            "-after\n"
            "+updated\n"
            "*** End Patch",
        )

        assert len(operations) == 1
        assert operations[0].kind == "update"
        assert changes[0].after == (
            b"before\n"
            b"*** Add File: not-an-operation.txt\n"
            b"updated\n"
        )


def test_codex_patch_uses_change_context_and_fuzzy_whitespace_matching() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.py").write_bytes(
            b"def first():\n"
            b"    return 1\n"
            b"\n"
            b"def target():\n"
            b"    value = 1   \n"
            b"    return value\n"
        )

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.py\n"
            "@@ def target():\n"
            "-    value = 1\n"
            "+    value = 2\n"
            "*** End Patch",
        )

        assert changes[0].after == (
            b"def first():\n"
            b"    return 1\n"
            b"\n"
            b"def target():\n"
            b"    value = 2\n"
            b"    return value\n"
        )


def test_codex_patch_preserves_fuzzy_matched_context_line_contents() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.py").write_bytes(
            b"if enabled:   \n"
            b"    old_value\n"
        )

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.py\n"
            "@@\n"
            " if enabled:\n"
            "-    old_value\n"
            "+    new_value\n"
            "*** End Patch",
        )

        assert changes[0].after == b"if enabled:   \n    new_value\n"


def test_codex_patch_supports_end_of_file_append() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes(b"alpha\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            "@@\n"
            "+omega\n"
            "*** End of File\n"
            "\n"
            "*** End Patch",
        )

        assert changes[0].after == b"alpha\nomega\n"


def test_codex_patch_supports_move_and_destination_overwrite() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "old.txt").write_bytes(b"old\n")
        (root / "new.txt").write_bytes(b"existing\n")

        operations, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: old.txt\n"
            "*** Move to: new.txt\n"
            "@@\n"
            "-old\n"
            "+updated\n"
            "*** End Patch",
        )

        assert operations[0].move_path == "new.txt"
        by_path = {change.path: change for change in changes}
        assert by_path["old.txt"].after is None
        assert by_path["new.txt"].before == b"existing\n"
        assert by_path["new.txt"].after == b"updated\n"


def test_codex_patch_accepts_lenient_heredoc_wrapper_and_unicode_matching() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes('title = “hello”\n'.encode())

        _, changes = _prepare(
            root,
            "<<'EOF'\n"
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            '@@\n'
            '-title = "hello"\n'
            '+title = "world"\n'
            "*** End Patch\n"
            "EOF\n",
        )

        assert changes[0].after == b'title = "world"\n'

def test_codex_patch_allows_binary_diff_marker_as_plain_text() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes(b"before\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            "@@\n"
            "-before\n"
            "+GIT binary patch\n"
            "*** End Patch",
        )

        assert changes[0].after == b"GIT binary patch\n"

def test_codex_patch_evaluates_add_then_update_against_evolving_state() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Add File: a.txt\n"
            "+one\n"
            "*** Update File: a.txt\n"
            "@@\n"
            "-one\n"
            "+two\n"
            "*** End Patch",
        )

        assert len(changes) == 1
        assert changes[0].path == "a.txt"
        assert changes[0].before is None
        assert changes[0].after == b"two\n"


def test_codex_patch_evaluates_move_then_update_against_evolving_state() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "old.txt").write_bytes(b"one\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: old.txt\n"
            "*** Move to: moved.txt\n"
            "@@\n"
            "-one\n"
            "+two\n"
            "*** Update File: moved.txt\n"
            "@@\n"
            "-two\n"
            "+three\n"
            "*** End Patch",
        )

        by_path = {change.path: change for change in changes}
        assert by_path["old.txt"].after is None
        assert by_path["moved.txt"].after == b"three\n"


def test_codex_add_file_may_replace_existing_utf8_text() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "a.txt").write_bytes(b"old\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Add File: a.txt\n"
            "+new\n"
            "*** End Patch",
        )

        assert len(changes) == 1
        assert changes[0].before == b"old\n"
        assert changes[0].after == b"new\n"


def test_codex_patch_rejects_move_to_same_canonical_path() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "same.txt").write_bytes(b"one\n")

        with pytest.raises(WorkspaceToolError) as captured:
            _prepare(
                root,
                "*** Begin Patch\n"
                "*** Update File: same.txt\n"
                "*** Move to: ./same.txt\n"
                "@@\n"
                "-one\n"
                "+two\n"
                "*** End Patch",
            )

        assert captured.value.code == "WORKSPACE_PATCH_INVALID"
        assert "must differ" in captured.value.message


def test_codex_patch_canonicalizes_path_aliases_to_one_transaction_target() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "a.txt").write_bytes(b"one\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: ./a.txt\n"
            "@@\n"
            "-one\n"
            "+two\n"
            "*** Update File: dir/../a.txt\n"
            "@@\n"
            "-two\n"
            "+three\n"
            "*** End Patch",
        )

        assert len(changes) == 1
        assert changes[0].path == "a.txt"
        commit_prepared_changes(root, changes)
        assert (root / "a.txt").read_bytes() == b"three\n"


def test_codex_move_rejects_existing_binary_destination() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "old.txt").write_bytes(b"one\n")
        (root / "dest.bin").write_bytes(b"\x00\xff")

        with pytest.raises(WorkspaceToolError) as captured:
            _prepare(
                root,
                "*** Begin Patch\n"
                "*** Update File: old.txt\n"
                "*** Move to: dest.bin\n"
                "@@\n"
                "-one\n"
                "+two\n"
                "*** End Patch",
            )

        assert captured.value.code == "WORKSPACE_BINARY_NOT_ALLOWED"


@pytest.mark.skipif(os.name != "nt", reason="Windows paths are case-insensitive")
def test_codex_patch_uses_path_identity_for_missing_windows_case_aliases() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Add File: New.txt\n"
            "+one\n"
            "*** Update File: new.txt\n"
            "@@\n"
            "-one\n"
            "+two\n"
            "*** End Patch",
        )

        assert len(changes) == 1
        assert changes[0].after == b"two\n"


@pytest.mark.skipif(os.name != "nt", reason="Windows path alias rules are Win32-specific")
@pytest.mark.parametrize(
    "path",
    [
        "trailing-dot.txt.",
        "file.txt:stream",
        "CON",
        "con.txt",
        "nested/AUX.log",
    ],
)
def test_codex_patch_rejects_ambiguous_windows_paths(path: str) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)

        with pytest.raises(WorkspaceToolError) as captured:
            _prepare(
                root,
                "*** Begin Patch\n"
                f"*** Add File: {path}\n"
                "+content\n"
                "*** End Patch",
            )

        assert captured.value.code == "WORKSPACE_INVALID_PATH"


@pytest.mark.parametrize(
    "path",
    [
        "CON .txt",
        "PRN .txt",
        "AUX .txt",
        "NUL .txt",
        "COM1 .txt",
        "LPT9 .txt",
    ],
)
def test_windows_reserved_path_fallback_handles_device_aliases_with_spaces(
    path: str,
) -> None:
    with patch.object(os.path, "isreserved", None, create=True):
        assert _windows_path_is_reserved(Path(path)) is True


def test_codex_delete_file_allows_binary_content() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "binary.bin").write_bytes(b"\x00\xff")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Delete File: binary.bin\n"
            "*** End Patch",
            allow_delete=True,
        )

        assert len(changes) == 1
        assert changes[0].before == b"\x00\xff"
        assert changes[0].after is None


def test_codex_preserve_line_endings_keeps_unchanged_context_terminator() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "mixed.txt").write_bytes(b"alpha\r\nkeep\nbeta\r\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: mixed.txt\n"
            "@@\n"
            " keep\n"
            "-beta\n"
            "+gamma\n"
            "*** End Patch",
        )

        assert changes[0].after == b"alpha\r\nkeep\ngamma\r\n"


def test_codex_preserve_line_endings_adds_trailing_newline_on_update() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "unterminated.txt").write_bytes(b"before")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: unterminated.txt\n"
            "@@\n"
            "-before\n"
            "+after\n"
            "*** End Patch",
        )

        assert changes[0].after == b"after\n"


def test_codex_no_newline_marker_is_noop_after_end_of_file() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "sample.txt").write_bytes(b"before\n")

        _, changes = _prepare(
            root,
            "*** Begin Patch\n"
            "*** Update File: sample.txt\n"
            "@@\n"
            "-before\n"
            "+after\n"
            "*** End of File\n"
            "\\ No newline at end of file\n"
            "*** End Patch",
        )

        assert changes[0].after == b"after\n"
