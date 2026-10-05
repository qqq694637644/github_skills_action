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
Replacement = tuple[int, int, list[str]]


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


@dataclass
class _SourceLine:
    text: str
    ending: str | None


@dataclass
class _SourceFile:
    lines: list[_SourceLine]
    preferred_ending: str

    @classmethod
    def parse(cls, contents: str) -> _SourceFile:
        lines: list[_SourceLine] = []
        preferred_ending: str | None = None
        line_start = 0
        cursor = 0
        while cursor < len(contents):
            if contents.startswith("\r\n", cursor):
                ending = "\r\n"
                ending_len = 2
            elif contents[cursor] == "\r":
                ending = "\r"
                ending_len = 1
            elif contents[cursor] == "\n":
                ending = "\n"
                ending_len = 1
            else:
                cursor += 1
                continue
            preferred_ending = preferred_ending or ending
            lines.append(_SourceLine(contents[line_start:cursor], ending))
            cursor += ending_len
            line_start = cursor
        if line_start < len(contents):
            lines.append(_SourceLine(contents[line_start:], None))
        return cls(lines, preferred_ending or "\n")

    def line_texts(self) -> list[str]:
        return [line.text for line in self.lines]

    def apply_replacements(self, replacements: list[Replacement]) -> None:
        source_index = 0
        new_lines: list[_SourceLine] = []
        for start_idx, old_len, new_segment in replacements:
            new_lines.extend(self.lines[source_index:start_idx])
            new_lines.extend(
                _SourceLine(text, self.preferred_ending) for text in new_segment
            )
            source_index = start_idx + old_len
        new_lines.extend(self.lines[source_index:])
        for line in new_lines:
            if line.ending is None:
                line.ending = self.preferred_ending
        self.lines = new_lines

    def into_contents(self) -> str:
        return "".join(line.text + (line.ending or "") for line in self.lines)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def target_path(root: Path, path: str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        raise WorkspaceToolError(
            "WORKSPACE_PATH_OUTSIDE_ROOT",
            f"Workspace paths must be relative to the workspace root: {path}",
        )
    if os.name == "nt" and _windows_path_is_reserved(candidate):
        raise WorkspaceToolError(
            "WORKSPACE_INVALID_PATH",
            (
                "Workspace paths cannot use Windows-reserved or ambiguous path syntax "
                f"(for example trailing dots/spaces, NTFS ADS, or device names): {path}"
            ),
        )

    resolved_root = root.resolve()
    resolved = (resolved_root / candidate).resolve(strict=False)
    if resolved != resolved_root and not resolved.is_relative_to(resolved_root):
        raise WorkspaceToolError(
            "WORKSPACE_PATH_OUTSIDE_ROOT",
            f"Workspace path resolves outside the workspace root: {path}",
        )
    return resolved


def _windows_path_is_reserved(path: Path) -> bool:
    """Reject Win32 aliases/special names before they can diverge from reported path identity."""
    isreserved = getattr(os.path, "isreserved", None)
    if isreserved is not None:
        return bool(isreserved(str(path)))

    device_names = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    device_names.update(f"COM{suffix}" for suffix in "123456789¹²³")
    device_names.update(f"LPT{suffix}" for suffix in "123456789¹²³")
    invalid_chars = '<>:"|?*'
    for component in path.parts:
        if component in {".", ".."}:
            continue
        if component.endswith((" ", ".")):
            return True
        if any(ord(char) < 32 or char in invalid_chars for char in component):
            return True
        device_stem = component.split(".", 1)[0].upper()
        if device_stem in device_names:
            return True
    return False


def canonical_workspace_path(root: Path, path: str) -> tuple[str, Path]:
    resolved_root = root.resolve()
    resolved = target_path(root, path)
    canonical = resolved.relative_to(resolved_root).as_posix()
    return canonical, resolved


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
    seen: set[Path] = set()
    for path in paths:
        canonical, resolved = canonical_workspace_path(root, path)
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.exists():
            if not resolved.is_file():
                raise WorkspaceToolError(
                    "WORKSPACE_INVALID_PATH",
                    f"Workspace text operations only support files: {canonical}",
                )
            snapshots.append(FileSnapshot(canonical, resolved, True, resolved.read_bytes()))
        else:
            snapshots.append(FileSnapshot(canonical, resolved, False, None))
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
    parser = _PatchParser(
        root=root,
        allow_delete=allow_delete,
        max_changed_files=max_changed_files,
    )
    return parser.parse(lines)


def prepare_text_patch(
    root: Path,
    operations: list[TextPatchOperation],
    snapshots: list[FileSnapshot],
) -> list[PreparedFileChange]:
    current = {snapshot.resolved_path: snapshot.data for snapshot in snapshots}
    for operation in operations:
        identity = target_path(root, operation.path)
        if operation.kind == "add":
            existing = current.get(identity)
            if existing is not None:
                assert_text_bytes(existing, path=operation.path)
            current[identity] = _join_lines(
                operation.add_lines,
                trailing_newline=bool(operation.add_lines),
            ).encode("utf-8")
        elif operation.kind == "delete":
            original = current.get(identity)
            if original is None:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Delete File target does not exist as a file: {operation.path}",
                )
            current[identity] = None
        else:
            original = current.get(identity)
            if original is None:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_CONTEXT_MISMATCH",
                    f"Patch update target no longer exists: {operation.path}",
                )
            assert_text_bytes(original, path=operation.path)
            source_file = _SourceFile.parse(original.decode("utf-8"))
            replacements = _compute_replacements(
                source_file.line_texts(), operation.hunks, operation.path
            )
            source_file.apply_replacements(replacements)
            updated = source_file.into_contents().encode("utf-8")
            if operation.move_path is not None:
                destination_identity = target_path(root, operation.move_path)
                destination = current.get(destination_identity)
                if destination is not None:
                    assert_text_bytes(destination, path=operation.move_path)
                current[destination_identity] = updated
                current[identity] = None
            else:
                current[identity] = updated
    return [
        PreparedFileChange(
            path=snapshot.path,
            resolved_path=snapshot.resolved_path,
            before=snapshot.data,
            after=current[snapshot.resolved_path],
        )
        for snapshot in snapshots
        if snapshot.data != current[snapshot.resolved_path]
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


class _PatchParser:
    """Line-oriented parser modeled on Codex StreamingPatchParser."""

    def __init__(self, *, root: Path, allow_delete: bool, max_changed_files: int) -> None:
        self.root = root
        self.allow_delete = allow_delete
        self.max_changed_files = max_changed_files
        self.mode: Literal["started", "add", "delete", "update", "ended"] = "started"
        self.operations: list[TextPatchOperation] = []
        self.paths_seen: set[Path] = set()

    def parse(self, lines: list[str]) -> list[TextPatchOperation]:
        for line_number, line in enumerate(lines[1:], start=2):
            self._process_line(line, line_number)
        if self.mode != "ended":
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"The last line of the patch must be '{_END_PATCH_MARKER}'.",
            )
        return self.operations

    def _process_line(self, line: str, line_number: int) -> None:
        if self.mode == "ended":
            if not line.strip():
                return
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"The last line of the patch must be '{_END_PATCH_MARKER}'.",
            )

        if self.mode == "update":
            self._process_update_line(line, line_number)
            return

        marker = line.strip()
        if not marker:
            if self.mode == "add":
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    (
                        f"Invalid blank Add File line {line_number}; "
                        "use '+' to add an empty content line."
                    ),
                )
            # Preserve separator leniency in Started/Delete states.
            return
        if self._handle_header(marker, line_number):
            return

        if self.mode == "add" and line.startswith("+"):
            self.operations[-1].add_lines.append(line[1:])
            return
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID",
            (
                f"Invalid patch line {line_number}: {line!r}. "
                "Expected an Add/Delete/Update File header"
                + (" or an Add File line starting with '+'." if self.mode == "add" else ".")
            ),
        )

    def _handle_header(self, marker: str, line_number: int) -> bool:
        if marker == _END_PATCH_MARKER:
            self._ensure_update_not_empty(marker, line_number)
            self.mode = "ended"
            return True

        for prefix, kind in (
            (_ADD_FILE_MARKER, "add"),
            (_DELETE_FILE_MARKER, "delete"),
            (_UPDATE_FILE_MARKER, "update"),
        ):
            if not marker.startswith(prefix):
                continue
            self._ensure_update_not_empty(marker, line_number)
            raw_path = marker.removeprefix(prefix).strip()
            if not raw_path:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Patch file path cannot be empty at line {line_number}.",
                )
            path, _ = canonical_workspace_path(self.root, raw_path)
            if kind == "delete" and not self.allow_delete:
                raise WorkspaceToolError(
                    "WORKSPACE_DELETE_NOT_ALLOWED",
                    f"Delete File is disabled for this request: {path}",
                )
            if kind == "add":
                operation = TextPatchOperation(kind="add", path=path)
            elif kind == "delete":
                operation = TextPatchOperation(kind="delete", path=path)
            else:
                operation = TextPatchOperation(kind="update", path=path)
            self.operations.append(operation)
            self.mode = kind
            self._record_path(path)
            return True
        return False

    def _record_path(self, path: str) -> None:
        self.paths_seen.add(target_path(self.root, path))
        if len(self.paths_seen) > self.max_changed_files:
            raise WorkspaceToolError(
                "WORKSPACE_TOO_MANY_CHANGED_FILES",
                (
                    f"Patch changes too many files: {len(self.paths_seen)} "
                    f"> {self.max_changed_files}."
                ),
            )

    def _ensure_update_not_empty(self, line: str, line_number: int) -> None:
        if self.mode != "update":
            return
        operation = self._update_operation()
        if not operation.hunks:
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"Update File operation has no hunks: {operation.path}",
            )
        last = operation.hunks[-1]
        if not last.old_lines and not last.new_lines:
            message = (
                "Update hunk does not contain any lines"
                if line == _END_PATCH_MARKER
                else (
                    f"Unexpected line found in update hunk: {line!r}. "
                    "Every line should start with space, '+', or '-'."
                )
            )
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"{message} at line {line_number}: {operation.path}",
            )

    def _update_operation(self) -> TextPatchOperation:
        if not self.operations or self.operations[-1].kind != "update":
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                "Internal patch parser state is not an Update File operation.",
            )
        return self.operations[-1]

    def _update_hunk(self, *, create: bool = False) -> TextPatchHunk | None:
        operation = self._update_operation()
        if operation.hunks:
            return operation.hunks[-1]
        if not create:
            return None
        hunk = TextPatchHunk()
        operation.hunks.append(hunk)
        return hunk

    def _process_update_line(self, line: str, line_number: int) -> None:
        update_line = line.rstrip()
        # Match Codex: Update state trims only the end, so a leading-space marker
        # remains a context line instead of becoming a new operation.
        if self._handle_header(update_line, line_number):
            return

        # Keep this common git-style marker as a lenient no-op at every Update position,
        # including immediately after "*** End of File".
        if line.startswith("\\ No newline at end of file"):
            return

        operation = self._update_operation()
        last = self._update_hunk()
        if last is not None and last.is_end_of_file:
            if not update_line:
                return
            if update_line != "@@" and not update_line.startswith("@@ "):
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    (
                        "Expected update hunk to start with a @@ context marker, got: "
                        f"{line!r}"
                    ),
                )

        if not operation.hunks and operation.move_path is None and update_line.startswith(
            _MOVE_TO_MARKER
        ):
            raw_candidate = update_line.removeprefix(_MOVE_TO_MARKER).strip()
            if not raw_candidate:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Move destination cannot be empty: {operation.path}",
                )
            candidate, candidate_resolved = canonical_workspace_path(self.root, raw_candidate)
            if candidate_resolved == target_path(self.root, operation.path):
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Move destination must differ from the source path: {operation.path}",
                )
            self.operations[-1] = TextPatchOperation(
                kind="update",
                path=operation.path,
                hunks=operation.hunks,
                move_path=candidate,
            )
            self._record_path(candidate)
            return

        last = self._update_hunk()
        if (
            (update_line == "@@" or update_line.startswith("@@ "))
            and last is not None
            and not last.old_lines
            and not last.new_lines
        ):
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                (
                    f"Unexpected line found in update hunk: {line!r}. "
                    "Every line should start with space, '+', or '-'."
                ),
            )

        if update_line == "@@" or update_line.startswith("@@ "):
            context = None if update_line == "@@" else update_line[3:]
            self._update_operation().hunks.append(TextPatchHunk(change_context=context))
            return

        if update_line == _END_OF_FILE_MARKER:
            last = self._update_hunk()
            if last is not None and not last.old_lines and not last.new_lines:
                raise WorkspaceToolError(
                    "WORKSPACE_PATCH_INVALID",
                    f"Update hunk does not contain any lines: {operation.path}",
                )
            if last is not None:
                self._update_operation().hunks[-1] = TextPatchHunk(
                    change_context=last.change_context,
                    old_lines=last.old_lines,
                    new_lines=last.new_lines,
                    context_line_indices=last.context_line_indices,
                    is_end_of_file=True,
                )
            return

        hunk = self._update_hunk(create=True)
        assert hunk is not None
        if line == "":
            hunk.context_line_indices.append((len(hunk.old_lines), len(hunk.new_lines)))
            hunk.old_lines.append("")
            hunk.new_lines.append("")
            return
        if line.startswith(" "):
            value = line[1:]
            hunk.context_line_indices.append((len(hunk.old_lines), len(hunk.new_lines)))
            hunk.old_lines.append(value)
            hunk.new_lines.append(value)
            return
        if line.startswith("+"):
            hunk.new_lines.append(line[1:])
            return
        if line.startswith("-"):
            hunk.old_lines.append(line[1:])
            return
        if hunk.old_lines or hunk.new_lines:
            raise WorkspaceToolError(
                "WORKSPACE_PATCH_INVALID",
                f"Expected update hunk to start with a @@ context marker, got: {line!r}",
            )
        raise WorkspaceToolError(
            "WORKSPACE_PATCH_INVALID",
            (
                f"Unexpected line found in update hunk: {line!r}. "
                "Every line should start with space, '+', or '-'."
            ),
        )


def _compute_replacements(
    lines: list[str], hunks: list[TextPatchHunk], path: str
) -> list[Replacement]:
    """Compute Codex PreserveLineEndings replacements while leaving context lines untouched."""
    replacements: list[Replacement] = []
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

        old_start = 0
        new_start = 0
        for old_context, new_context in hunk.context_line_indices:
            if old_context >= len(pattern) or new_context >= len(replacement):
                break
            if old_start != old_context or new_start != new_context:
                replacements.append(
                    (
                        idx + old_start,
                        old_context - old_start,
                        replacement[new_start:new_context],
                    )
                )
            old_start = old_context + 1
            new_start = new_context + 1
        if old_start != len(pattern) or new_start != len(replacement):
            replacements.append(
                (
                    idx + old_start,
                    len(pattern) - old_start,
                    replacement[new_start:],
                )
            )
        cursor = idx + len(pattern)

    replacements.sort(key=lambda item: item[0])
    return replacements


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
