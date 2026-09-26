from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

OperationState = Literal["running", "succeeded", "failed", "timed_out", "canceled", "interrupted"]
WorkspaceId = Annotated[str, Field(pattern=r"^ws_[0-9a-f]{16}$")]
OperationId = Annotated[str, Field(pattern=r"^op_[0-9a-f]{16}$")]
IdempotencyKey = Annotated[str, Field(min_length=8, max_length=200)]
WorkspacePath = Annotated[str, Field(min_length=1, max_length=500)]
QueryText = Annotated[str, Field(min_length=1, max_length=500)]
ScriptText = Annotated[str, Field(min_length=1, max_length=20000)]
PatchText = Annotated[str, Field(min_length=1)]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$")]
Paths = Annotated[list[WorkspacePath], Field(min_length=1, max_length=50)]
Queries = Annotated[list[QueryText], Field(max_length=10)]
PositiveInt = Annotated[int, Field(ge=1)]
ResponseBytes = Annotated[int, Field(ge=1024)]
LogOffset = Annotated[int, Field(ge=0)]
LogBytes = Annotated[int, Field(ge=1, le=500_000)]
WaitSeconds = Annotated[float, Field(ge=0, le=30)]
MaxLines = Annotated[int, Field(ge=1, le=5000)]
ContextLines = Annotated[int, Field(ge=0, le=20)]
MaxMatches = Annotated[int, Field(ge=1, le=1000)]
MaxDepth = Annotated[int, Field(ge=1, le=10)]
MaxTreeEntries = Annotated[int, Field(ge=1, le=5000)]
MaxReadFiles = Annotated[int, Field(ge=0, le=50)]


class WorkspaceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WorkspaceScopedModel(WorkspaceModel):
    workspace_id: WorkspaceId


class PrepareWorkspaceRequest(WorkspaceModel):
    idempotency_key: IdempotencyKey | None = None
    workspace_id: WorkspaceId | None = None

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
    paths: Paths
    start_line: PositiveInt = 1
    max_lines: MaxLines = 200
    max_bytes_per_file: PositiveInt | None = None
    max_bytes: ResponseBytes | None = None


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
    query: QueryText
    regex: bool = False
    case_sensitive: bool = False
    paths: Paths = Field(default_factory=lambda: ["."])
    context_lines: ContextLines = 2
    max_matches: MaxMatches = 100
    max_bytes: ResponseBytes | None = None


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
    paths: Paths = Field(default_factory=lambda: ["."])
    queries: Queries = Field(default_factory=list)
    max_depth: MaxDepth = 2
    max_tree_entries: MaxTreeEntries = 200
    context_lines: ContextLines = 2
    max_search_matches: MaxMatches = 50
    max_read_files: MaxReadFiles = 10
    max_file_lines: MaxLines = 120
    max_bytes_per_file: PositiveInt | None = None
    max_bytes: ResponseBytes | None = None


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
    path: WorkspacePath
    content: str
    mode: Literal["create_only", "overwrite", "overwrite_if_sha256_matches"] = "create_only"
    encoding: Literal["utf-8"] = "utf-8"
    line_ending: Literal["preserve", "lf", "crlf"] = "preserve"
    expected_sha256: Sha256 | None = None
    dry_run: bool = False
    max_bytes: PositiveInt | None = None

    @model_validator(mode="after")
    def validate_hash_checked_overwrite(self) -> WorkspaceWriteFileRequest:
        if self.mode == "overwrite_if_sha256_matches" and self.expected_sha256 is None:
            raise ValueError("expected_sha256 is required when mode=overwrite_if_sha256_matches")
        return self


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
    patch: PatchText
    dry_run: bool = False
    allow_delete: bool = False
    max_changed_files: PositiveInt | None = None
    max_patch_bytes: PositiveInt | None = None


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
    idempotency_key: IdempotencyKey | None = None
    workspace_id: WorkspaceId | None = None
    script: ScriptText | None = None
    timeout_seconds: PositiveInt | None = None
    max_output_bytes: PositiveInt | None = None
    plain_output: bool = False
    utf8_output: bool = True
    operation_id: OperationId | None = None
    stdout_offset: LogOffset = 0
    stderr_offset: LogOffset = 0
    max_bytes: LogBytes = 50_000
    wait_seconds: WaitSeconds = 5.0
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
