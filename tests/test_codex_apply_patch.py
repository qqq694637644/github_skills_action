from __future__ import annotations

import tempfile
from pathlib import Path

from workspace_mcp.workspace_patch import (
    parse_codex_patch,
    prepare_text_patch,
    snapshot_files,
)


def _prepare(root: Path, patch: str):
    operations = parse_codex_patch(
        patch,
        root,
        allow_delete=False,
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
