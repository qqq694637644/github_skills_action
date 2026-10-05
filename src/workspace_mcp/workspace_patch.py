from __future__ import annotations

import difflib
import hashlib
import os
import secrets
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

PatchKind = Literal["update", "add", "delete"]


_BEGIN_PATCH_MARKER = "*** Begin Patch"
_END_PATCH_MARKER = "*** End Patch"
_ADD_FILE_MARKER = "*** Add File: "
_DELETE_FILE_MARKER = "*** Delete File: "
_UPDATE_FILE_MARKER = "*** Update File: "
_MOVE_TO_MARKER = "*** Move to: "
_END_OF_FILE_MARKER = "*** End of File"


class WorkspaceToolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class TextPatchHunk:
    change_context: str | None = None
    old_lines: list[str] = field(default_factory=list)
    new_lines: list[str] = field(default_factory=list)
    context_line_indices: list[tuple[int, int]] = field(default_factory=list)
    is_end_of_file: bool = False


@dataclass(frozen=True)
class TextPatchOperation:
    kind: PatchKind
    path: str
    hunks: list[TextPatchHunk] = field(default_factory=list)
    add_lines: list[str] = field(default_factory=list)
    move_path: str | None = None


@dataclass(frozen=True)
class FileSnapshot:
    path: str
    resolved_path: Path
    existed: bool
    data: bytes | None


@dataclass(frozen=True)
class PreparedFileChange:
    path: str
    resolved_path: Path
    before: bytes | None
    after: bytes | None


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def target_path(root: Path, path: str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        raise WorkspaceToolError(
            "WORKSPACE_PATH_OUTSIDE_ROOT",
            f"Workspace paths must be relative to the workspace root: {path}",
        )

    resolved_root = root.resolve()
    resolved = (resolved_root / candidate).resolve(strict=False)
    if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
        raise WorkspaceToolError(
            "WORKSPACE_PATH_OUTSIDE_ROOT",
            f"Workspace path resolves outside the workspace root: {path}",
        )
    return resolved


def path_is_within_workspace(root: Path, path: Path) -> bool:
    resolved_root = root.resolve()
    try:
        resolved = path.resolve(strict=False)
    except OSError:
        return False
    return resolved == resolved_root or resolved.is_relative_to(resolved_root)


def assert_payload_size(data: bytes, *, max_bytes: int, label: str) -> None:
    if len(data) > max_bytes:
        raise WorkspaceToolError(
            "WORKSPACE_PAYLOAD_TOO_LARGE",
            f"{label} is too large: {len(data)} bytes > {max_bytes} bytes.",
        )


def assert_text_bytes(data: bytes, *, path: str | None = None) -> None:
    if b"\x00" in data:
        raise WorkspaceToolError(
            "WORKSPACE_BINARY_NOT_ALLOWED",
            "NUL bytes are not allowed in workspace text operations.",
        )
    try:
        data.decode("utf-8")
    except UnicodeDecodeError as exc:
        suffix = f" Path: {path}." if path else ""
        raise WorkspaceToolError(
            "WORKSPACE_BINARY_NOT_ALLOWED",
            f"Only UTF-8 text files are allowed in workspace text operations.{suffix}",
        ) from exc


def snapshot_files(root: Path, paths: list[str]) -> list[FileSnapshot]:
    snapshots: list[FileSnapshot] = []
    seen: set[str] = set()
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        resolved = target_path(root, path)
        if resolved.exists():
            if not resolved.is_file():
                raise WorkspaceToolError(
                    "WORKSPACE_INVALID_PATH",
                    f"Workspace text operations only support files: {path}",
                )
            snapshots.append(FileSnapshot(path, resolved, True, resolved.read_bytes()))
        else:
            snapshots.append(FileSnapshot(path, resolved, False, None))
    return snapshots


def parse_codex_patch(
    patch: str,
    root: Path,
    *,
    allow_delete: bool,
    max_changed_files: int,
) -> list[TextPatchOperation]:
    payload = patch.encode("utf-8")
    assert_text_bytes(payload)
    lines = _patch_lines(patch)

    operations: list[TextPatchOperation] = []
    paths_seen: set[str] = set()
    idx = 1
    while idx < len(lines) - 1:
        line = lines[idx]
        if not line.strip():
            idx += 1
            continue
        marker = line.strip()
        if marker.startswith(_UPDATE_FILE_MARKER):
            path = marker.removeprefix(_UPDATE_FILE_MARKER).strip()
            resolved = target_path(root, path)
            if not resolved.exists() or not resolved.is_file():
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Update File target does not exist as a file: {path}",
                )
            body, idx = _collect_operation_body(lines, idx + 1)
            hunks, move_path = _parse_update_hunks(body, path, root)
            operations.append(
                TextPatchOperation(
                    kind="update",
                    path=path,
                    hunks=hunks,
                    move_path=move_path,
                )
            )
        elif marker.startswith(_ADD_FILE_MARKER):
            path = marker.removeprefix(_ADD_FILE_MARKER).strip()
            if target_path(root, path).exists():
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Add File target already exists: {path}",
                )
            body, idx = _collect_operation_body(lines, idx + 1)
            operations.append(
                TextPatchOperation(
                    kind="add",
                    path=path,
                    add_lines=_parse_add_file_lines(body, path),
                )
            )
        elif marker.startswith(_DELETE_FILE_MARKER):
            path = marker.removeprefix(_DELETE_FILE_MARKER).strip()
            if not allow_delete:
                raise WorkspaceToolError(
                    "WORKSPACE_DELETE_NOT_ALLOWED",
                    f"Delete File is disabled for this request: {path}",
                )
            resolved = target_path(root, path)
            if not resolved.exists() or not resolved.is_file():
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Delete File target does not exist as a file: {path}",
                )
            body, idx = _collect_operation_body(lines, idx + 1)
            if any(item.strip() for item in body):
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Delete File sections cannot contain file content: {path}",
                )
            operations.append(TextPatchOperation(kind="delete", path=path))
        else:
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID", f"Unsupported patch operation: {line}"
            )
        operation = operations[-1]
        paths_seen.add(operation.path)
        if operation.move_path is not None:
            paths_seen.add(operation.move_path)
        if len(paths_seen) > max_changed_files:
            raise WorkspaceToolError(
                "WORKSPACE_TOO_MANY_CHANGED_FILES",
                f"Patch changes too many files: {len(paths_seen)} > {max_changed_files}.",
            )

    if not operations:
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID", "Patch does not contain any file operations."
        )
    return operations


def prepare_text_patch(
    root: Path,
    operations: list[TextPatchOperation],
    snapshots: list[FileSnapshot],
) -> list[PreparedFileChange]:
    current = {snapshot.path: snapshot.data for snapshot in snapshots}
    for operation in operations:
        if operation.kind == "add":
            current[operation.path] = _join_lines(
                operation.add_lines,
                trailing_newline=bool(operation.add_lines),
            ).encode("utf-8")
        elif operation.kind == "delete":
            current[operation.path] = None
        else:
            original = current[operation.path]
            if original is None:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_CONTEXT_MISMATCH",
                    f"Patch update target no longer exists: {operation.path}",
                )
            assert_text_bytes(original, path=operation.path)
            original_text = original.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
            lines, trailing = _split_text_lines(original_text)
            new_lines = _apply_hunks(lines, operation.hunks, operation.path)
            rendered = _join_lines(
                new_lines,
                trailing_newline=trailing,
            )
            rendered = normalize_line_endings(
                rendered,
                line_ending="preserve",
                previous_bytes=original,
            )
            updated = rendered.encode("utf-8")
            if operation.move_path is not None and operation.move_path != operation.path:
                current[operation.move_path] = updated
                current[operation.path] = None
            else:
                current[operation.path] = updated
    return [
        PreparedFileChange(
            path=snapshot.path,
            resolved_path=snapshot.resolved_path,
            before=snapshot.data,
            after=current[snapshot.path],
        )
        for snapshot in snapshots
        if snapshot.data != current[snapshot.path]
    ]


def prepare_write_change(
    *,
    path: str,
    resolved_path: Path,
    before: bytes | None,
    after: bytes,
) -> list[PreparedFileChange]:
    if before == after:
        return []
    return [
        PreparedFileChange(
            path=path,
            resolved_path=resolved_path,
            before=before,
            after=after,
        )
    ]


def commit_prepared_changes(root: Path, changes: list[PreparedFileChange]) -> None:
    transaction_parent = root.parent / ".workspace-mcp-transactions"
    transaction_dir = transaction_parent / ("txn_" + secrets.token_hex(12))
    staged_dir = transaction_dir / "staged"
    backup_dir = transaction_dir / "backups"
    staged: dict[str, Path] = {}
    backups: dict[str, Path] = {}
    created_dirs: set[Path] = set()
    committed: list[PreparedFileChange] = []
    transaction_dir.mkdir(parents=True, exist_ok=False)
    try:
        for index, change in enumerate(changes):
            if change.after is not None:
                staged_dir.mkdir(parents=True, exist_ok=True)
                temporary = staged_dir / f"{index:04d}.stage"
                staged[change.path] = temporary
                temporary.write_bytes(change.after)

        for index, change in enumerate(changes):
            target = change.resolved_path
            created_dirs.update(_missing_parent_dirs(target.parent))
            target.parent.mkdir(parents=True, exist_ok=True)
            if change.before is not None:
                backup_dir.mkdir(parents=True, exist_ok=True)
                backup = backup_dir / f"{index:04d}.backup"
                os.replace(target, backup)
                backups[change.path] = backup
            committed.append(change)
            if change.after is not None:
                temporary = staged[change.path]
                os.replace(temporary, target)
                staged.pop(change.path)
    except Exception as original:
        rollback_errors = _rollback_committed_changes(committed, backups)
        _remove_created_dirs(created_dirs, root)
        cleanup_error = _cleanup_transaction_dir(transaction_dir, transaction_parent)
        if rollback_errors or cleanup_error is not None:
            details = list(rollback_errors)
            if cleanup_error is not None:
                details.append(str(cleanup_error))
            raise WorkspaceToolError(
                "WORKSPACE_TRANSACTION_RECOVERY_FAILED",
                "Workspace transaction failed and cleanup was incomplete: " + "; ".join(details),
            ) from original
        raise
    cleanup_error = _cleanup_transaction_dir(transaction_dir, transaction_parent)
    if cleanup_error is not None:
        raise WorkspaceToolError(
            "WORKSPACE_TRANSACTION_CLEANUP_FAILED",
            "Workspace changes were committed, but transaction cleanup failed. "
            "The committed files were left intact: "
            f"{cleanup_error}",
        ) from cleanup_error


def _rollback_committed_changes(
    committed: list[PreparedFileChange],
    backups: dict[str, Path],
) -> list[str]:
    errors: list[str] = []
    for change in reversed(committed):
        target = change.resolved_path
        try:
            if change.before is not None:
                backup = backups.get(change.path)
                if backup is None or not backup.exists():
                    errors.append(
                        f"{change.path}: backup is unavailable; the current target was left intact"
                    )
                    continue
                if target.exists() and target.is_file():
                    target.unlink()
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(backup, target)
            elif target.exists() and target.is_file():
                target.unlink()
        except OSError as exc:
            errors.append(f"{change.path}: {exc}")
    return errors


def _remove_created_dirs(created_dirs: set[Path], root: Path) -> None:
    for directory in sorted(created_dirs, key=lambda item: len(item.parts), reverse=True):
        if directory == root:
            continue
        try:
            directory.rmdir()
        except OSError:
            pass


def _cleanup_transaction_dir(transaction_dir: Path, transaction_parent: Path) -> OSError | None:
    try:
        shutil.rmtree(transaction_dir)
        try:
            transaction_parent.rmdir()
        except OSError:
            pass
        return None
    except OSError as exc:
        return exc


def describe_changes(
    changes: list[PreparedFileChange],
) -> tuple[list[dict[str, object]], str]:
    changed: list[dict[str, object]] = []
    for change in changes:
        before = change.before
        after = change.after
        if before is None:
            operation = "added"
        elif after is None:
            operation = "deleted"
        else:
            operation = "modified"
        additions, deletions = _line_change_counts(before, after)
        changed.append(
            {
                "path": change.path,
                "operation": operation,
                "status": None,
                "previous_path": None,
                "additions": additions,
                "deletions": deletions,
            }
        )
    lines = [
        f"{item['path']} | +{item['additions']} -{item['deletions']} ({item['operation']})"
        for item in changed
    ]
    if changed:
        lines.append(
            f"{len(changed)} file(s) changed, "
            f"{sum(int(item['additions']) for item in changed)} insertion(s), "
            f"{sum(int(item['deletions']) for item in changed)} deletion(s)"
        )
    return changed, "\n".join(lines)


def _missing_parent_dirs(path: Path) -> set[Path]:
    missing: set[Path] = set()
    current = path
    while not current.exists():
        missing.add(current)
        if current.parent == current:
            break
        current = current.parent
    return missing


def normalize_line_endings(content: str, *, line_ending: str, previous_bytes: bytes | None) -> str:
    if line_ending == "preserve":
        if (
            previous_bytes
            and b"\r\n" in previous_bytes
            and previous_bytes.count(b"\r\n") >= previous_bytes.count(b"\n")
        ):
            line_ending = "crlf"
        else:
            return content
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if line_ending == "lf":
        return normalized
    if line_ending == "crlf":
        return normalized.replace("\n", "\r\n")
    raise WorkspaceToolError(
        "VALIDATION_ERROR",
        f"Unsupported line ending mode: {line_ending}",
    )


# Parser and matching semantics below are adapted from OpenAI Codex's
# codex-rs/apply-patch implementation (Apache-2.0).
def _patch_lines(patch: str) -> list[str]:
    """Normalize the Codex apply_patch envelope, including its lenient heredoc form."""
    lines = patch.strip().splitlines()
    if (
        len(lines) >= 4
        and lines[0].strip() in {"<<EOF", "<<'EOF'", '<<"EOF"'}
        and lines[-1].strip().endswith("EOF")
    ):
        lines = lines[1:-1]
    if not lines or lines[0].strip() != _BEGIN_PATCH_MARKER:
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID",
            f"The first line of the patch must be '{_BEGIN_PATCH_MARKER}'.",
        )
    if lines[-1].strip() != _END_PATCH_MARKER:
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID",
            f"The last line of the patch must be '{_END_PATCH_MARKER}'.",
        )
    return lines


def _collect_operation_body(lines: list[str], start: int) -> tuple[list[str], int]:
    end = start
    prefixes = (_UPDATE_FILE_MARKER, _ADD_FILE_MARKER, _DELETE_FILE_MARKER)
    while end < len(lines) - 1 and not lines[end].startswith(prefixes):
        end += 1
    return lines[start:end], end


def _parse_add_file_lines(body: list[str], path: str) -> list[str]:
    output: list[str] = []
    for line in body:
        if not line.startswith("+"):
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"Add File content lines must start with '+': {path}: {line}",
            )
        output.append(line[1:])
    if not output:
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID",
            f"Add File operation must contain at least one '+' line: {path}",
        )
    return output


def _parse_update_hunks(
    body: list[str],
    path: str,
    root: Path,
) -> tuple[list[TextPatchHunk], str | None]:
    """Parse the update grammar used by Codex's apply-patch streaming parser."""
    hunks: list[TextPatchHunk] = []
    move_path: str | None = None
    change_context: str | None = None
    old_lines: list[str] | None = None
    new_lines: list[str] | None = None
    context_line_indices: list[tuple[int, int]] | None = None
    is_end_of_file = False

    def start_hunk(context: str | None = None) -> None:
        nonlocal change_context, old_lines, new_lines, context_line_indices, is_end_of_file
        change_context = context
        old_lines = []
        new_lines = []
        context_line_indices = []
        is_end_of_file = False

    def finish_hunk() -> None:
        nonlocal change_context, old_lines, new_lines, context_line_indices, is_end_of_file
        if old_lines is None or new_lines is None or context_line_indices is None:
            return
        if not old_lines and not new_lines:
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"Update hunk does not contain any lines: {path}",
            )
        hunks.append(
            TextPatchHunk(
                change_context=change_context,
                old_lines=old_lines,
                new_lines=new_lines,
                context_line_indices=context_line_indices,
                is_end_of_file=is_end_of_file,
            )
        )
        change_context = None
        old_lines = None
        new_lines = None
        context_line_indices = None
        is_end_of_file = False

    for line in body:
        update_line = line.rstrip()
        if (
            not hunks
            and old_lines is None
            and move_path is None
            and update_line.startswith(_MOVE_TO_MARKER)
        ):
            candidate = update_line.removeprefix(_MOVE_TO_MARKER).strip()
            if not candidate:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Move destination cannot be empty: {path}",
                )
            target_path(root, candidate)
            if candidate == path:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Move destination must differ from the source path: {path}",
                )
            move_path = candidate
            continue

        if update_line == "@@" or update_line.startswith("@@ "):
            finish_hunk()
            context = None if update_line == "@@" else update_line[3:]
            start_hunk(context)
            continue

        if is_end_of_file:
            if update_line == "":
                continue
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"Expected a new '@@' hunk after '{_END_OF_FILE_MARKER}': {path}",
            )

        if update_line == _END_OF_FILE_MARKER:
            if old_lines is None or (not old_lines and not new_lines):
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"'{_END_OF_FILE_MARKER}' requires a non-empty update hunk: {path}",
                )
            is_end_of_file = True
            continue

        if line.startswith("\\ No newline at end of file"):
            continue

        if old_lines is None:
            start_hunk()
        assert old_lines is not None
        assert new_lines is not None
        assert context_line_indices is not None

        if line == "":
            context_line_indices.append((len(old_lines), len(new_lines)))
            old_lines.append("")
            new_lines.append("")
        elif line.startswith(" "):
            value = line[1:]
            context_line_indices.append((len(old_lines), len(new_lines)))
            old_lines.append(value)
            new_lines.append(value)
        elif line.startswith("+"):
            new_lines.append(line[1:])
        elif line.startswith("-"):
            old_lines.append(line[1:])
        else:
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                (
                    f"Unexpected line in update hunk for {path}: {line!r}. "
                    "Every line must start with space, '+', or '-'."
                ),
            )

    finish_hunk()
    if not hunks:
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID", f"Update File operation has no hunks: {path}"
        )
    return hunks, move_path


def _apply_hunks(lines: list[str], hunks: list[TextPatchHunk], path: str) -> list[str]:
    """Compute replacements using Codex's ordered context seeking, then apply them in reverse."""
    replacements: list[tuple[int, int, list[str]]] = []
    cursor = 0
    for hunk in hunks:
        if hunk.change_context is not None:
            context_idx = _seek_sequence(
                lines,
                [hunk.change_context],
                cursor,
                eof=False,
            )
            if context_idx is None:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_CONTEXT_MISMATCH",
                    f"Failed to find context {hunk.change_context!r} in {path}",
                )
            cursor = context_idx + 1

        if not hunk.old_lines:
            replacements.append((len(lines), 0, list(hunk.new_lines)))
            continue

        pattern = list(hunk.old_lines)
        replacement = list(hunk.new_lines)
        idx = _seek_sequence(
            lines,
            pattern,
            cursor,
            eof=hunk.is_end_of_file,
        )
        if idx is None and pattern and pattern[-1] == "":
            pattern = pattern[:-1]
            if replacement and replacement[-1] == "":
                replacement = replacement[:-1]
            idx = _seek_sequence(
                lines,
                pattern,
                cursor,
                eof=hunk.is_end_of_file,
            )
        if idx is None:
            expected = "\n".join(hunk.old_lines)
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_CONTEXT_MISMATCH",
                f"Failed to find expected lines in {path}:\n{expected}",
            )

        for old_index, new_index in hunk.context_line_indices:
            if old_index < len(pattern) and new_index < len(replacement):
                replacement[new_index] = lines[idx + old_index]
        replacements.append((idx, len(pattern), replacement))
        cursor = idx + len(pattern)

    current = list(lines)
    for start, old_len, replacement in sorted(replacements, key=lambda item: item[0], reverse=True):
        current[start : start + old_len] = replacement
    return current


def _seek_sequence(
    lines: list[str],
    pattern: list[str],
    start: int,
    *,
    eof: bool,
) -> int | None:
    """Match like Codex: exact, rstrip, strip, then common Unicode normalization."""
    if not pattern:
        return max(start, 0)
    if len(pattern) > len(lines):
        return None
    last_start = len(lines) - len(pattern)
    first_start = max(start, 0)
    if first_start > last_start:
        return None
    positions = range(last_start, last_start + 1) if eof else range(first_start, last_start + 1)

    def find_with(normalize: object) -> int | None:
        for idx in positions:
            if normalize is None:
                if lines[idx : idx + len(pattern)] == pattern:
                    return idx
                continue
            normalizer = normalize
            if all(
                normalizer(lines[idx + offset]) == normalizer(expected)
                for offset, expected in enumerate(pattern)
            ):
                return idx
        return None

    exact = find_with(None)
    if exact is not None:
        return exact
    rstrip = find_with(str.rstrip)
    if rstrip is not None:
        return rstrip
    stripped = find_with(str.strip)
    if stripped is not None:
        return stripped
    return find_with(_normalize_patch_match_text)


def _normalize_patch_match_text(value: str) -> str:
    translations = str.maketrans(
        {
            "\u2010": "-",
            "\u2011": "-",
            "\u2012": "-",
            "\u2013": "-",
            "\u2014": "-",
            "\u2015": "-",
            "\u2212": "-",
            "\u2018": "'",
            "\u2019": "'",
            "\u201a": "'",
            "\u201b": "'",
            "\u201c": '"',
            "\u201d": '"',
            "\u201e": '"',
            "\u201f": '"',
            "\u00a0": " ",
            "\u2002": " ",
            "\u2003": " ",
            "\u2004": " ",
            "\u2005": " ",
            "\u2006": " ",
            "\u2007": " ",
            "\u2008": " ",
            "\u2009": " ",
            "\u200a": " ",
            "\u202f": " ",
            "\u205f": " ",
            "\u3000": " ",
        }
    )
    return value.strip().translate(translations)


def _split_text_lines(text: str) -> tuple[list[str], bool]:
    if text == "":
        return [], False
    parts = text.split("\n")
    trailing = parts[-1] == ""
    return (parts[:-1] if trailing else parts), trailing


def _join_lines(lines: list[str], *, trailing_newline: bool) -> str:
    text = "\n".join(lines)
    return text + ("\n" if trailing_newline else "")


def _line_change_counts(before: bytes | None, after: bytes | None) -> tuple[int, int]:
    old = (
        [] if before is None else before.decode("utf-8", errors="replace").splitlines(keepends=True)
    )
    new = [] if after is None else after.decode("utf-8", errors="replace").splitlines(keepends=True)
    additions = 0
    deletions = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old, b=new).get_opcodes():
        if tag in {"insert", "replace"}:
            additions += j2 - j1
        if tag in {"delete", "replace"}:
            deletions += i2 - i1
    return additions, deletions
