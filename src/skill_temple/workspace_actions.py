"""Local workspace GPT Actions ported from github-gpt-actions-gateway."""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .action_logging import command_for_log, log_action, log_action_error
from .workspace_files import LocalWorkspaceService
from .workspace_patch import WorkspaceToolError


class WorkspaceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkspaceScopedModel(WorkspaceModel):
    workspace_id: str = Field(pattern=r"^ws_[0-9a-f]{16}$")


class PrepareWorkspaceRequest(WorkspaceModel):
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    workspace_id: str | None = Field(default=None, pattern=r"^ws_[0-9a-f]{16}$")

    @model_validator(mode="after")
    def validate_prepare_fields(self) -> PrepareWorkspaceRequest:
        if self.workspace_id is None and self.idempotency_key is None:
            raise ValueError("idempotency_key is required when creating a workspace")
        return self


class PrepareWorkspaceResponse(WorkspaceModel):
    workspace_id: str
    created: bool
    empty: bool


class ChangedFile(WorkspaceModel):
    path: str
    operation: str
    status: str | None = None
    previous_path: str | None = None
    additions: int = 0
    deletions: int = 0


class WorkspaceFileContent(WorkspaceModel):
    path: str
    start_line: int
    end_line: int | None = None
    total_lines: int | None = None
    bytes: int | None = None
    sha256: str | None = None
    content: str = ""
    truncated: bool = False
    next_start_line: int | None = None
    error: str | None = None


class WorkspaceReadFilesRequest(WorkspaceScopedModel):
    paths: list[str] = Field(
        min_length=1,
        max_length=50,
        description="Exact existing file paths already identified by the user, inspect, or search.",
    )
    start_line: int = Field(default=1, ge=1)
    max_lines: int = Field(default=200, ge=1, le=5000)
    max_bytes_per_file: int | None = Field(default=None, ge=1)
    max_bytes: int | None = Field(default=None, ge=1024)


class WorkspaceReadFilesResponse(WorkspaceModel):
    files: list[WorkspaceFileContent]
    truncated: bool = False


class WorkspaceSearchMatch(WorkspaceModel):
    path: str
    line_number: int
    column: int | None = None
    line: str
    snippet: str | None = None


class WorkspaceSearchRequest(WorkspaceScopedModel):
    query: str = Field(
        min_length=1,
        max_length=500,
        description="Literal text by default, or a ripgrep pattern when regex=true.",
    )
    regex: bool = Field(
        default=False,
        description=(
            "False uses ripgrep --fixed-strings. True uses ripgrep's default regular-expression "
            "engine; PCRE2-specific syntax is not enabled by this Action."
        ),
    )
    case_sensitive: bool = Field(
        default=False,
        description="False adds ripgrep --ignore-case; true preserves case sensitivity.",
    )
    paths: list[str] = Field(
        default_factory=lambda: ["."],
        min_length=1,
        max_length=50,
        description=(
            "Existing workspace file or directory paths to search. Values are literal paths, "
            "not glob patterns."
        ),
    )
    context_lines: int = Field(default=2, ge=0, le=20)
    max_matches: int = Field(default=100, ge=1, le=1000)
    max_bytes: int | None = Field(default=None, ge=1024)


class WorkspaceSearchResponse(WorkspaceModel):
    query: str
    engine: Literal["ripgrep"]
    matches: list[WorkspaceSearchMatch]
    match_count: int
    truncated: bool = Field(
        default=False,
        description=(
            "True when match-count or response-byte limits prevented returning all results."
        ),
    )


class WorkspaceTreeEntry(WorkspaceModel):
    path: str
    type: Literal["file", "dir"]
    depth: int
    bytes: int | None = None


class WorkspaceInspectRequest(WorkspaceScopedModel):
    paths: list[str] = Field(
        default_factory=lambda: ["."],
        min_length=1,
        max_length=50,
        description=(
            "Existing workspace file or directory paths to inspect. Values are literal paths, "
            "not glob patterns."
        ),
    )
    queries: list[str] = Field(
        default_factory=list,
        max_length=10,
        description=(
            "Up to 10 literal case-insensitive search strings used during inspection. Regular "
            "expressions are not supported here; use workspaceSearch with regex=true instead."
        ),
    )
    max_depth: int = Field(default=2, ge=1, le=10)
    max_tree_entries: int = Field(default=200, ge=1, le=5000)
    context_lines: int = Field(default=2, ge=0, le=20)
    max_search_matches: int = Field(default=50, ge=1, le=1000)
    max_read_files: int = Field(default=10, ge=0, le=50)
    max_file_lines: int = Field(default=120, ge=1, le=5000)
    max_bytes_per_file: int | None = Field(default=None, ge=1)
    max_bytes: int | None = Field(default=None, ge=1024)


class WorkspaceInspectSearchResult(WorkspaceModel):
    query: str
    engine: Literal["ripgrep"]
    matches: list[WorkspaceSearchMatch]
    match_count: int
    truncated: bool = Field(
        default=False,
        description=(
            "True when match-count or response-byte limits prevented returning all results."
        ),
    )


class WorkspaceInspectResponse(WorkspaceModel):
    tree: list[WorkspaceTreeEntry]
    tree_truncated: bool = False
    searches: list[WorkspaceInspectSearchResult] = Field(default_factory=list)
    files: list[WorkspaceFileContent] = Field(default_factory=list)
    truncated: bool = Field(
        default=False,
        description="True when any bounded inspect section was truncated.",
    )


class WorkspaceWriteFileRequest(WorkspaceScopedModel):
    path: str = Field(min_length=1, max_length=500)
    content: str
    mode: Literal["create_only", "overwrite", "overwrite_if_sha256_matches"] = "create_only"
    encoding: Literal["utf-8"] = "utf-8"
    line_ending: Literal["preserve", "lf", "crlf"] = "preserve"
    expected_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    dry_run: bool = False
    max_bytes: int | None = Field(default=None, ge=1)


class WorkspaceWriteFileResponse(WorkspaceModel):
    written: bool
    dry_run: bool
    path: str
    operation: str
    previous_sha256: str | None = None
    new_sha256: str
    bytes: int
    changed_files: list[ChangedFile]
    diff_stat: str


class WorkspaceApplyPatchRequest(WorkspaceScopedModel):
    patch: str = Field(min_length=1)
    dry_run: bool = False
    allow_delete: bool = False
    max_changed_files: int | None = Field(default=None, ge=1)
    max_patch_bytes: int | None = Field(default=None, ge=1)


class WorkspaceApplyPatchResponse(WorkspaceModel):
    applied: bool
    dry_run: bool
    changed_files: list[ChangedFile]
    diff_stat: str


class WorkspaceOperationSummary(WorkspaceModel):
    operation_id: str
    workspace_id: str | None = None
    script_sha256: str
    script_summary: str
    state: Literal["running", "succeeded", "failed", "timed_out", "canceled", "interrupted"]
    root_pid: int | None = None
    job_assigned: bool = False
    started_at: str
    deadline_at: str
    finished_at: str | None = None
    duration_ms: int = 0
    exit_code: int | None = None
    stdout_bytes: int = 0
    stderr_bytes: int = 0
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    error_code: str | None = None
    error_message: str | None = None


class WorkspaceCommandRequest(WorkspaceModel):
    action: Literal["start", "get", "logs", "cancel", "list"] = Field(
        description=(
            "start launches a command; get reads status; logs reads output; cancel stops it; "
            "list enumerates operations."
        )
    )
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    workspace_id: str | None = Field(default=None, pattern=r"^ws_[0-9a-f]{16}$")
    script: str | None = Field(default=None, min_length=1, max_length=20000)
    timeout_seconds: int | None = Field(default=None, ge=1)
    max_output_bytes: int | None = Field(default=None, ge=1)
    plain_output: bool = False
    utf8_output: bool = True
    operation_id: str | None = Field(default=None, pattern=r"^op_[0-9a-f]{16}$")
    stdout_offset: int = Field(default=0, ge=0)
    stderr_offset: int = Field(default=0, ge=0)
    max_bytes: int = Field(default=50_000, ge=1, le=500_000)
    state: (
        Literal["running", "succeeded", "failed", "timed_out", "canceled", "interrupted"]
        | None
    ) = None

    @model_validator(mode="after")
    def validate_action_fields(self) -> WorkspaceCommandRequest:
        if self.action == "start":
            missing = [
                name
                for name, value in (
                    ("idempotency_key", self.idempotency_key),
                    ("workspace_id", self.workspace_id),
                    ("script", self.script),
                )
                if value is None
            ]
            if missing:
                raise ValueError(f"action=start requires: {', '.join(missing)}")
        elif self.action in {"get", "logs", "cancel"} and self.operation_id is None:
            raise ValueError(f"action={self.action} requires: operation_id")
        return self


class WorkspaceCommandResponse(WorkspaceModel):
    action: Literal["start", "get", "logs", "cancel", "list"]
    operation: WorkspaceOperationSummary | None = None
    operations: list[WorkspaceOperationSummary] = Field(default_factory=list)
    stdout: str = ""
    stderr: str = ""
    next_stdout_offset: int = 0
    next_stderr_offset: int = 0
    stdout_eof: bool = False
    stderr_eof: bool = False


def _raise_http(exc: WorkspaceToolError) -> None:
    raise HTTPException(
        status_code=exc.status_code,
        detail={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "suggested_next_action": "check_workspace_request",
            }
        },
    ) from exc


def register_workspace_actions(app: FastAPI) -> None:
    service = LocalWorkspaceService()
    app.state.local_workspace_service = service

    app.router.add_event_handler("shutdown", service.shutdown)

    @app.post(
        "/v1/workspace/prepare",
        operation_id="prepareWorkspace",
        response_model=PrepareWorkspaceResponse,
        summary="Create or reuse a persistent workspace.",
        description=(
            "Create an empty persistent workspace or reuse an existing workspace_id. Returns "
            "workspace_id plus created/empty; repo and branch state remain unmanaged."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def prepare_workspace(request: PrepareWorkspaceRequest) -> PrepareWorkspaceResponse:
        try:
            response = PrepareWorkspaceResponse.model_validate(
                await service.prepare_workspace(**request.model_dump())
            )
            log_action(
                "prepareWorkspace",
                requested_workspace_id=request.workspace_id,
                workspace_id=response.workspace_id,
                created=response.created,
                empty=response.empty,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "prepareWorkspace",
                workspace_id=request.workspace_id,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/command",
        operation_id="workspaceCommand",
        response_model=WorkspaceCommandResponse,
        summary="Start or manage a PowerShell workspace command.",
        description=(
            "Run or manage asynchronous PowerShell 7 work. start returns an operation; follow "
            "with get/logs until a terminal state before treating the command as complete."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_command(request: WorkspaceCommandRequest) -> WorkspaceCommandResponse:
        try:
            if request.action == "start":
                assert (
                    request.idempotency_key is not None
                    and request.workspace_id is not None
                    and request.script is not None
                )
                operation = WorkspaceOperationSummary.model_validate(
                    await service.command_start(
                        idempotency_key=request.idempotency_key,
                        workspace_id=request.workspace_id,
                        script=request.script,
                        timeout_seconds=request.timeout_seconds,
                        max_output_bytes=request.max_output_bytes,
                        plain_output=request.plain_output,
                        utf8_output=request.utf8_output,
                    )
                )
                log_action(
                    "workspaceCommand",
                    action="start",
                    workspace_id=request.workspace_id,
                    command=command_for_log(request.script),
                    timeout_seconds=request.timeout_seconds,
                    max_output_bytes=request.max_output_bytes,
                    plain_output=True if request.plain_output else None,
                    utf8_output=False if not request.utf8_output else None,
                    operation_id=operation.operation_id,
                    state=operation.state,
                )
                return WorkspaceCommandResponse(action="start", operation=operation)
            if request.action == "get":
                assert request.operation_id is not None
                operation = WorkspaceOperationSummary.model_validate(
                    await service.command_get(request.operation_id)
                )
                if operation.state != "running":
                    log_action(
                        "workspaceCommand",
                        action="get",
                        operation_id=request.operation_id,
                        state=operation.state,
                        exit_code=operation.exit_code,
                        duration_ms=operation.duration_ms,
                        stdout_bytes=operation.stdout_bytes,
                        stderr_bytes=operation.stderr_bytes,
                        error_code=operation.error_code,
                    )
                return WorkspaceCommandResponse(action="get", operation=operation)
            if request.action == "cancel":
                assert request.operation_id is not None
                operation = WorkspaceOperationSummary.model_validate(
                    await service.command_cancel(request.operation_id)
                )
                log_action(
                    "workspaceCommand",
                    action="cancel",
                    operation_id=request.operation_id,
                    state=operation.state,
                )
                return WorkspaceCommandResponse(action="cancel", operation=operation)
            if request.action == "list":
                operations = [
                    WorkspaceOperationSummary.model_validate(operation)
                    for operation in await service.command_list(request.state)
                ]
                log_action(
                    "workspaceCommand",
                    action="list",
                    state_filter=request.state,
                    count=len(operations),
                )
                return WorkspaceCommandResponse(action="list", operations=operations)
            assert request.operation_id is not None
            logs = await service.command_logs(
                request.operation_id,
                stdout_offset=request.stdout_offset,
                stderr_offset=request.stderr_offset,
                max_bytes=request.max_bytes,
            )
            log_action(
                "workspaceCommand",
                action="logs",
                operation_id=request.operation_id,
                stdout_offset=request.stdout_offset if request.stdout_offset else None,
                stderr_offset=request.stderr_offset if request.stderr_offset else None,
                max_bytes=request.max_bytes if request.max_bytes != 50_000 else None,
                stdout_chars=len(logs["stdout"]),
                stderr_chars=len(logs["stderr"]),
                stdout_eof=logs["stdout_eof"],
                stderr_eof=logs["stderr_eof"],
            )
            return WorkspaceCommandResponse(action="logs", **logs)
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceCommand",
                action=request.action,
                workspace_id=request.workspace_id,
                operation_id=request.operation_id,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/inspect",
        operation_id="workspaceInspect",
        response_model=WorkspaceInspectResponse,
        summary="Discover an unfamiliar workspace before choosing exact paths.",
        description=(
            "First pass for unfamiliar paths. Returns a bounded tree plus optional literal "
            "search matches and matching file snippets; truncated means discovery is incomplete."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_inspect(request: WorkspaceInspectRequest) -> WorkspaceInspectResponse:
        try:
            response = WorkspaceInspectResponse.model_validate(
                await service.inspect(**request.model_dump())
            )
            log_action(
                "workspaceInspect",
                workspace_id=request.workspace_id,
                paths=request.paths,
                queries=request.queries,
                max_depth=request.max_depth if request.max_depth != 2 else None,
                tree_entries=len(response.tree),
                search_count=len(response.searches),
                files_read=len(response.files),
                truncated=response.truncated,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceInspect",
                workspace_id=request.workspace_id,
                paths=request.paths,
                queries=request.queries,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/search",
        operation_id="workspaceSearch",
        response_model=WorkspaceSearchResponse,
        summary="Locate code and text in known workspace paths with ripgrep.",
        description=(
            "Primary locator when the exact file or impact location is unknown, or when tracing "
            "references. Returns path/line/snippet matches; truncated means results are incomplete."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_search(request: WorkspaceSearchRequest) -> WorkspaceSearchResponse:
        try:
            response = WorkspaceSearchResponse.model_validate(
                await service.search(**request.model_dump())
            )
            log_action(
                "workspaceSearch",
                workspace_id=request.workspace_id,
                query=request.query,
                regex=True if request.regex else None,
                case_sensitive=True if request.case_sensitive else None,
                paths=request.paths,
                context_lines=request.context_lines if request.context_lines != 2 else None,
                max_matches=request.max_matches if request.max_matches != 100 else None,
                match_count=response.match_count,
                truncated=response.truncated,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceSearch",
                workspace_id=request.workspace_id,
                query=request.query,
                paths=request.paths,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/read-files",
        operation_id="workspaceReadFiles",
        response_model=WorkspaceReadFilesResponse,
        summary="Read selected UTF-8 files after their exact paths are known.",
        description=(
            "Read bounded content from exact known files. Returns numbered content, hashes, and "
            "next_start_line when a file is truncated; use inspect/search for discovery."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_read_files(
        request: WorkspaceReadFilesRequest,
    ) -> WorkspaceReadFilesResponse:
        try:
            response = WorkspaceReadFilesResponse.model_validate(
                await service.read_files(**request.model_dump())
            )
            log_action(
                "workspaceReadFiles",
                workspace_id=request.workspace_id,
                paths=request.paths,
                start_line=request.start_line if request.start_line != 1 else None,
                max_lines=request.max_lines if request.max_lines != 200 else None,
                files=len(response.files),
                truncated=response.truncated,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceReadFiles",
                workspace_id=request.workspace_id,
                paths=request.paths,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/write-file",
        operation_id="workspaceWriteFile",
        response_model=WorkspaceWriteFileResponse,
        summary="Write one UTF-8 text file.",
        description=(
            "Create or replace one known text file in the workspace. Returns hashes, "
            "changed_files, and diff_stat; this does not commit or publish changes."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_write_file(
        request: WorkspaceWriteFileRequest,
    ) -> WorkspaceWriteFileResponse:
        try:
            payload = request.model_dump(exclude={"encoding"})
            response = WorkspaceWriteFileResponse.model_validate(
                await service.write_file(**payload)
            )
            log_action(
                "workspaceWriteFile",
                workspace_id=request.workspace_id,
                path=request.path,
                mode=request.mode,
                line_ending=request.line_ending if request.line_ending != "preserve" else None,
                dry_run=True if request.dry_run else None,
                content_bytes=len(request.content.encode("utf-8")),
                expected_sha256=request.expected_sha256,
                written=response.written,
                operation=response.operation,
                bytes=response.bytes,
                diff_stat=response.diff_stat,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceWriteFile",
                workspace_id=request.workspace_id,
                path=request.path,
                mode=request.mode,
                dry_run=request.dry_run,
                error_code=exc.code,
            )
            _raise_http(exc)

    @app.post(
        "/v1/workspace/apply-patch",
        operation_id="workspaceApplyPatch",
        response_model=WorkspaceApplyPatchResponse,
        summary="Apply a controlled Codex text patch.",
        description=(
            "Apply a multi-file text patch with dry-run and rollback on failure. Returns "
            "changed_files and diff_stat; this does not commit or publish changes."
        ),
        openapi_extra={"x-openai-isConsequential": False},
    )
    async def workspace_apply_patch(
        request: WorkspaceApplyPatchRequest,
    ) -> WorkspaceApplyPatchResponse:
        try:
            response = WorkspaceApplyPatchResponse.model_validate(
                await service.apply_patch(**request.model_dump())
            )
            log_action(
                "workspaceApplyPatch",
                workspace_id=request.workspace_id,
                patch_bytes=len(request.patch.encode("utf-8")),
                dry_run=True if request.dry_run else None,
                allow_delete=True if request.allow_delete else None,
                max_changed_files=request.max_changed_files,
                changed_files=[item.path for item in response.changed_files],
                diff_stat=response.diff_stat,
            )
            return response
        except WorkspaceToolError as exc:
            log_action_error(
                "workspaceApplyPatch",
                workspace_id=request.workspace_id,
                patch_bytes=len(request.patch.encode("utf-8")),
                dry_run=request.dry_run,
                allow_delete=request.allow_delete,
                error_code=exc.code,
            )
            _raise_http(exc)
