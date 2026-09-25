from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

OperationState = Literal["running", "succeeded", "failed", "timed_out", "canceled", "interrupted"]


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
    paths: list[str] = Field(min_length=1, max_length=50)
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
    query: str = Field(min_length=1, max_length=500)
    regex: bool = False
    case_sensitive: bool = False
    paths: list[str] = Field(default_factory=lambda: ["."], min_length=1, max_length=50)
    context_lines: int = Field(default=2, ge=0, le=20)
    max_matches: int = Field(default=100, ge=1, le=1000)
    max_bytes: int | None = Field(default=None, ge=1024)


class WorkspaceSearchResponse(WorkspaceModel):
    query: str
    engine: Literal["ripgrep"]
    matches: list[WorkspaceSearchMatch]
    match_count: int
    truncated: bool = False


class WorkspaceTreeEntry(WorkspaceModel):
    path: str
    type: Literal["file", "dir"]
    depth: int
    bytes: int | None = None


class WorkspaceInspectRequest(WorkspaceScopedModel):
    paths: list[str] = Field(default_factory=lambda: ["."], min_length=1, max_length=50)
    queries: list[str] = Field(default_factory=list, max_length=10)
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
    truncated: bool = False


class WorkspaceInspectResponse(WorkspaceModel):
    tree: list[WorkspaceTreeEntry]
    tree_truncated: bool = False
    searches: list[WorkspaceInspectSearchResult] = Field(default_factory=list)
    files: list[WorkspaceFileContent] = Field(default_factory=list)
    truncated: bool = False


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
    state: OperationState
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
    action: Literal["start", "get", "logs", "cancel", "list"]
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
    wait_seconds: float = Field(default=5.0, ge=0, le=30)
    state: OperationState | None = None

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
