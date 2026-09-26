from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import uvicorn
from mcp.server import MCPServer
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, Tool, ToolAnnotations
from pydantic import AnyHttpUrl, BaseModel, ValidationError

from .auth import JWTTokenVerifier
from .config import MCPSettings
from .logging import command_for_log, log_error, log_event
from .models import (
    ContextLines,
    IdempotencyKey,
    LogBytes,
    LogOffset,
    MaxDepth,
    MaxLines,
    MaxMatches,
    MaxReadFiles,
    MaxTreeEntries,
    OperationId,
    OperationState,
    PatchText,
    Paths,
    PositiveInt,
    PrepareWorkspaceRequest,
    PrepareWorkspaceResponse,
    Queries,
    QueryText,
    ResponseBytes,
    ScriptText,
    Sha256,
    WaitSeconds,
    WorkspaceApplyPatchRequest,
    WorkspaceApplyPatchResponse,
    WorkspaceCommandRequest,
    WorkspaceCommandResponse,
    WorkspaceId,
    WorkspaceInspectRequest,
    WorkspaceInspectResponse,
    WorkspaceOperationSummary,
    WorkspacePath,
    WorkspaceReadFilesRequest,
    WorkspaceReadFilesResponse,
    WorkspaceSearchRequest,
    WorkspaceSearchResponse,
    WorkspaceWriteFileRequest,
    WorkspaceWriteFileResponse,
)
from .workspace_files import LocalWorkspaceService
from .workspace_patch import WorkspaceToolError

SERVER_INSTRUCTIONS = (
    "Use workspaceInspect/workspaceSearch before guessing paths. Read exact files with "
    "workspaceReadFiles and modify text with workspaceWriteFile/workspaceApplyPatch. "
    "workspaceCommand separates PowerShell lifetime from one MCP call: start and get return "
    "incremental logs directly; use logs only to reread or page historical output."
)


class WorkspaceMCPServer(MCPServer):
    """Expose precise schemas and the back-compat OAuth mirror on every tool."""

    def __init__(self, *args: Any, required_scope: str, **kwargs: Any) -> None:
        self._workspace_security_schemes = [{"type": "oauth2", "scopes": [required_scope]}]
        super().__init__(*args, **kwargs)

    async def list_tools(self) -> list[Tool]:
        advertised: list[Tool] = []
        for tool in await super().list_tools():
            payload = tool.model_dump(by_alias=True, exclude_none=True)
            payload["inputSchema"] = _advertised_input_schema(tool.name, payload["inputSchema"])
            meta = dict(payload.get("_meta") or {})
            meta["securitySchemes"] = self._workspace_security_schemes
            payload["_meta"] = meta
            advertised.append(Tool.model_validate(payload))
        return advertised


class OAuthToolMetadataMiddleware:
    """Add OpenAI's top-level securitySchemes after MCP core result validation."""

    def __init__(self, required_scope: str) -> None:
        self._security_schemes = [{"type": "oauth2", "scopes": [required_scope]}]

    async def __call__(self, ctx: Any, call_next: Any) -> Any:
        result = await call_next(ctx)
        if ctx.method != "tools/list" or not isinstance(result, dict):
            return result
        tools = result.get("tools")
        if not isinstance(tools, list):
            return result

        patched_tools: list[Any] = []
        for item in tools:
            if not isinstance(item, dict):
                patched_tools.append(item)
                continue
            patched = dict(item)
            patched["securitySchemes"] = self._security_schemes
            meta = dict(patched.get("_meta") or {})
            meta["securitySchemes"] = self._security_schemes
            patched["_meta"] = meta
            patched_tools.append(patched)
        return {**result, "tools": patched_tools}


def _advertised_input_schema(name: str, schema: dict[str, Any]) -> dict[str, Any]:
    result = dict(schema)
    all_of = list(result.get("allOf") or [])
    if name == "prepareWorkspace":
        all_of.append(
            {
                "anyOf": [
                    {
                        "properties": {
                            "workspace_id": {"type": "string", "pattern": r"^ws_[0-9a-f]{16}$"}
                        },
                        "required": ["workspace_id"],
                    },
                    {
                        "properties": {
                            "idempotency_key": {
                                "type": "string",
                                "minLength": 8,
                                "maxLength": 200,
                            }
                        },
                        "required": ["idempotency_key"],
                    },
                ]
            }
        )
    elif name == "workspaceCommand":
        all_of.extend(
            [
                {
                    "if": {"properties": {"action": {"const": "start"}}},
                    "then": {
                        "properties": {
                            "idempotency_key": {
                                "type": "string",
                                "minLength": 8,
                                "maxLength": 200,
                            },
                            "workspace_id": {
                                "type": "string",
                                "pattern": r"^ws_[0-9a-f]{16}$",
                            },
                            "script": {"type": "string", "minLength": 1, "maxLength": 20_000},
                        },
                        "required": ["idempotency_key", "workspace_id", "script"],
                    },
                },
                *[
                    {
                        "if": {"properties": {"action": {"const": action}}},
                        "then": {
                            "properties": {
                                "operation_id": {
                                    "type": "string",
                                    "pattern": r"^op_[0-9a-f]{16}$",
                                }
                            },
                            "required": ["operation_id"],
                        },
                    }
                    for action in ("get", "logs", "cancel")
                ],
            ]
        )
    if all_of:
        result["allOf"] = all_of
    return result


_READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)
_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=False,
    open_world_hint=False,
)
_COMMAND = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=False,
    open_world_hint=True,
)
_PREPARE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)


def create_server(
    settings: MCPSettings | None = None,
    *,
    service: LocalWorkspaceService | None = None,
) -> MCPServer:
    settings = settings or MCPSettings.from_env()
    service = service or LocalWorkspaceService()

    @asynccontextmanager
    async def lifespan(_: MCPServer):
        try:
            yield None
        finally:
            await service.shutdown()

    server = WorkspaceMCPServer(
        name="workspace-mcp",
        title="Personal Remote Workspace",
        description="Persistent workspace tools with arbitrary PowerShell execution.",
        version="1.0.0",
        required_scope=settings.required_scope,
        instructions=SERVER_INSTRUCTIONS,
        token_verifier=JWTTokenVerifier(settings),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(settings.issuer),
            resource_server_url=AnyHttpUrl(settings.public_url),
            required_scopes=[settings.required_scope],
            validate_token_resource=True,
        ),
        middleware=[OAuthToolMetadataMiddleware(settings.required_scope)],
        lifespan=lifespan,
    )

    @server.tool(
        name="prepareWorkspace",
        title="Prepare workspace",
        description=(
            "Create an empty persistent workspace or reuse an existing workspace_id. "
            "When creating, idempotency_key is required; when reusing, workspace_id is required. "
            "Repository and branch state are not managed implicitly."
        ),
        annotations=_PREPARE,
    )
    async def prepare_workspace(
        idempotency_key: IdempotencyKey | None = None,
        workspace_id: WorkspaceId | None = None,
    ) -> Annotated[CallToolResult, PrepareWorkspaceResponse]:
        request = _validate(
            PrepareWorkspaceRequest, idempotency_key=idempotency_key, workspace_id=workspace_id
        )
        try:
            response = PrepareWorkspaceResponse.model_validate(
                await service.prepare_workspace(**request.model_dump())
            )
            log_event(
                "prepare_workspace",
                workspace_id=response.workspace_id,
                created=response.created,
                empty=response.empty,
            )
            state = "created" if response.created else "reused"
            return _success(
                response, f"Workspace {response.workspace_id} {state}; empty={response.empty}."
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceInspect",
        title="Inspect workspace",
        description=(
            "First pass for unfamiliar workspace paths. Returns a bounded tree plus optional "
            "literal search matches and matching file snippets. Paths are confined to the "
            "workspace root."
        ),
        annotations=_READ_ONLY,
    )
    async def workspace_inspect(
        workspace_id: WorkspaceId,
        paths: Paths | None = None,
        queries: Queries | None = None,
        max_depth: MaxDepth = 2,
        max_tree_entries: MaxTreeEntries = 200,
        context_lines: ContextLines = 2,
        max_search_matches: MaxMatches = 50,
        max_read_files: MaxReadFiles = 10,
        max_file_lines: MaxLines = 120,
        max_bytes_per_file: PositiveInt | None = None,
        max_bytes: ResponseBytes | None = None,
    ) -> Annotated[CallToolResult, WorkspaceInspectResponse]:
        request = _validate(
            WorkspaceInspectRequest,
            workspace_id=workspace_id,
            paths=paths if paths is not None else ["."],
            queries=queries if queries is not None else [],
            max_depth=max_depth,
            max_tree_entries=max_tree_entries,
            context_lines=context_lines,
            max_search_matches=max_search_matches,
            max_read_files=max_read_files,
            max_file_lines=max_file_lines,
            max_bytes_per_file=max_bytes_per_file,
            max_bytes=max_bytes,
        )
        try:
            response = WorkspaceInspectResponse.model_validate(
                await service.inspect(**request.model_dump())
            )
            return _success(
                response,
                "Inspected workspace: "
                f"{len(response.tree)} tree entries, {len(response.searches)} searches, "
                f"{len(response.files)} file snippets; truncated={response.truncated}.",
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceSearch",
        title="Search workspace",
        description=(
            "Primary locator for code or text when the exact file is unknown. Literal search is "
            "the default; set regex=true for ripgrep regular expressions. Search paths are "
            "confined to the workspace root."
        ),
        annotations=_READ_ONLY,
    )
    async def workspace_search(
        workspace_id: WorkspaceId,
        query: QueryText,
        regex: bool = False,
        case_sensitive: bool = False,
        paths: Paths | None = None,
        context_lines: ContextLines = 2,
        max_matches: MaxMatches = 100,
        max_bytes: ResponseBytes | None = None,
    ) -> Annotated[CallToolResult, WorkspaceSearchResponse]:
        request = _validate(
            WorkspaceSearchRequest,
            workspace_id=workspace_id,
            query=query,
            regex=regex,
            case_sensitive=case_sensitive,
            paths=paths if paths is not None else ["."],
            context_lines=context_lines,
            max_matches=max_matches,
            max_bytes=max_bytes,
        )
        try:
            response = WorkspaceSearchResponse.model_validate(
                await service.search(**request.model_dump())
            )
            return _success(
                response,
                f"Search returned {response.match_count} match(es); "
                f"truncated={response.truncated}.",
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceReadFiles",
        title="Read workspace files",
        description=(
            "Read bounded UTF-8 content from exact known files. Use inspect/search first "
            "when paths are not yet known. Paths are confined to the workspace root."
        ),
        annotations=_READ_ONLY,
    )
    async def workspace_read_files(
        workspace_id: WorkspaceId,
        paths: Paths,
        start_line: PositiveInt = 1,
        max_lines: MaxLines = 200,
        max_bytes_per_file: PositiveInt | None = None,
        max_bytes: ResponseBytes | None = None,
    ) -> Annotated[CallToolResult, WorkspaceReadFilesResponse]:
        request = _validate(
            WorkspaceReadFilesRequest,
            workspace_id=workspace_id,
            paths=paths,
            start_line=start_line,
            max_lines=max_lines,
            max_bytes_per_file=max_bytes_per_file,
            max_bytes=max_bytes,
        )
        try:
            response = WorkspaceReadFilesResponse.model_validate(
                await service.read_files(**request.model_dump())
            )
            return _success(
                response,
                f"Read {len(response.files)} file result(s); truncated={response.truncated}.",
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceWriteFile",
        title="Write workspace file",
        description=(
            "Create or replace one known UTF-8 text file. Supports create-only, overwrite, "
            "hash-checked overwrite, dry-run, and line-ending control. The target must remain "
            "inside the workspace root after path and symlink/junction resolution."
        ),
        annotations=_WRITE,
    )
    async def workspace_write_file(
        workspace_id: WorkspaceId,
        path: WorkspacePath,
        content: str,
        mode: Literal["create_only", "overwrite", "overwrite_if_sha256_matches"] = "create_only",
        encoding: Literal["utf-8"] = "utf-8",
        line_ending: Literal["preserve", "lf", "crlf"] = "preserve",
        expected_sha256: Sha256 | None = None,
        dry_run: bool = False,
        max_bytes: PositiveInt | None = None,
    ) -> Annotated[CallToolResult, WorkspaceWriteFileResponse]:
        request = _validate(
            WorkspaceWriteFileRequest,
            workspace_id=workspace_id,
            path=path,
            content=content,
            mode=mode,
            encoding=encoding,
            line_ending=line_ending,
            expected_sha256=expected_sha256,
            dry_run=dry_run,
            max_bytes=max_bytes,
        )
        try:
            response = WorkspaceWriteFileResponse.model_validate(
                await service.write_file(**request.model_dump(exclude={"encoding"}))
            )
            log_event(
                "workspace_write_file",
                workspace_id=workspace_id,
                path=path,
                operation=response.operation,
            )
            return _success(
                response,
                f"File {response.path}: {response.operation}, {response.bytes} byte(s), "
                f"dry_run={response.dry_run}.",
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceApplyPatch",
        title="Apply workspace patch",
        description=(
            "Apply a bounded multi-file text patch with optional dry-run and delete permission. "
            "Changes are committed atomically with rollback on failure. Every patch path is "
            "confined to the workspace root."
        ),
        annotations=_WRITE,
    )
    async def workspace_apply_patch(
        workspace_id: WorkspaceId,
        patch: PatchText,
        dry_run: bool = False,
        allow_delete: bool = False,
        max_changed_files: PositiveInt | None = None,
        max_patch_bytes: PositiveInt | None = None,
    ) -> Annotated[CallToolResult, WorkspaceApplyPatchResponse]:
        request = _validate(
            WorkspaceApplyPatchRequest,
            workspace_id=workspace_id,
            patch=patch,
            dry_run=dry_run,
            allow_delete=allow_delete,
            max_changed_files=max_changed_files,
            max_patch_bytes=max_patch_bytes,
        )
        try:
            response = WorkspaceApplyPatchResponse.model_validate(
                await service.apply_patch(**request.model_dump())
            )
            log_event(
                "workspace_apply_patch",
                workspace_id=workspace_id,
                dry_run=dry_run,
                changed_files=len(response.changed_files),
            )
            return _success(
                response,
                f"Patch affected {len(response.changed_files)} file(s); "
                f"dry_run={response.dry_run}.",
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceCommand",
        title="Run or manage PowerShell",
        description=(
            "Run arbitrary PowerShell 7 work with the full permissions of the service OS account; "
            "this tool is intentionally not path-confined to the workspace root. start returns "
            "logs after a "
            "short synchronous window; running operations are followed with get, which waits "
            "briefly for state/log changes and returns incremental stdout/stderr. logs rereads "
            "historical output; cancel stops the process tree; list enumerates operations. "
            "start requires idempotency_key, workspace_id, and script; get/logs/cancel require "
            "operation_id."
        ),
        annotations=_COMMAND,
    )
    async def workspace_command(
        action: Literal["start", "get", "logs", "cancel", "list"],
        idempotency_key: IdempotencyKey | None = None,
        workspace_id: WorkspaceId | None = None,
        script: ScriptText | None = None,
        timeout_seconds: PositiveInt | None = None,
        max_output_bytes: PositiveInt | None = None,
        plain_output: bool = False,
        utf8_output: bool = True,
        operation_id: OperationId | None = None,
        stdout_offset: LogOffset = 0,
        stderr_offset: LogOffset = 0,
        max_bytes: LogBytes = 50_000,
        wait_seconds: WaitSeconds = 5.0,
        state: OperationState | None = None,
    ) -> Annotated[CallToolResult, WorkspaceCommandResponse]:
        request = _validate(
            WorkspaceCommandRequest,
            action=action,
            idempotency_key=idempotency_key,
            workspace_id=workspace_id,
            script=script,
            timeout_seconds=timeout_seconds,
            max_output_bytes=max_output_bytes,
            plain_output=plain_output,
            utf8_output=utf8_output,
            operation_id=operation_id,
            stdout_offset=stdout_offset,
            stderr_offset=stderr_offset,
            max_bytes=max_bytes,
            wait_seconds=wait_seconds,
            state=state,
        )
        try:
            if action == "start":
                assert request.workspace_id is not None
                assert request.idempotency_key is not None
                assert request.script is not None
                result = await service.command_start(
                    workspace_id=request.workspace_id,
                    idempotency_key=request.idempotency_key,
                    script=request.script,
                    timeout_seconds=request.timeout_seconds,
                    max_output_bytes=request.max_output_bytes,
                    plain_output=request.plain_output,
                    utf8_output=request.utf8_output,
                    stdout_offset=request.stdout_offset,
                    stderr_offset=request.stderr_offset,
                    max_bytes=request.max_bytes,
                )
                operation = WorkspaceOperationSummary.model_validate(result.pop("operation"))
                log_event(
                    "workspace_command",
                    action="start",
                    workspace_id=request.workspace_id,
                    command=command_for_log(request.script),
                    operation_id=operation.operation_id,
                    state=operation.state,
                )
                response = WorkspaceCommandResponse(action="start", operation=operation, **result)
                return _command_result(response)
            if action == "get":
                assert request.operation_id is not None
                result = await service.command_get(
                    request.operation_id,
                    wait_seconds=request.wait_seconds,
                    stdout_offset=request.stdout_offset,
                    stderr_offset=request.stderr_offset,
                    max_bytes=request.max_bytes,
                )
                operation = WorkspaceOperationSummary.model_validate(result.pop("operation"))
                response = WorkspaceCommandResponse(action="get", operation=operation, **result)
                return _command_result(response)
            if action == "logs":
                assert request.operation_id is not None
                logs = await service.command_logs(
                    request.operation_id,
                    stdout_offset=request.stdout_offset,
                    stderr_offset=request.stderr_offset,
                    max_bytes=request.max_bytes,
                )
                response = WorkspaceCommandResponse(action="logs", **logs)
                return _command_result(response)
            if action == "cancel":
                assert request.operation_id is not None
                operation = WorkspaceOperationSummary.model_validate(
                    await service.command_cancel(request.operation_id)
                )
                response = WorkspaceCommandResponse(action="cancel", operation=operation)
                return _command_result(response)
            operations = [
                WorkspaceOperationSummary.model_validate(item)
                for item in await service.command_list(request.state)
            ]
            response = WorkspaceCommandResponse(action="list", operations=operations)
            return _command_result(response)
        except WorkspaceToolError as exc:
            log_error(
                "workspace_command",
                action=action,
                workspace_id=workspace_id,
                operation_id=operation_id,
                error_code=exc.code,
            )
            raise _tool_error(exc) from exc

    return server


def create_app(settings: MCPSettings | None = None):
    resolved = settings or MCPSettings.from_env()
    return create_server(resolved).streamable_http_app(
        streamable_http_path="/mcp",
        json_response=False,
        stateless_http=False,
        transport_security=_transport_security(resolved),
        host=resolved.host,
    )


def main() -> None:
    settings = MCPSettings.from_env()
    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port)


def _validate(model: type[Any], **values: Any):
    try:
        return model.model_validate(values)
    except ValidationError as exc:
        raise ToolError(_error_text("VALIDATION_ERROR", str(exc), "fix_tool_arguments")) from exc


def _tool_error(exc: WorkspaceToolError) -> ToolError:
    return ToolError(_error_text(exc.code, exc.message, "check_workspace_request"))


def _error_text(code: str, message: str, suggested_next_action: str) -> str:
    return json.dumps(
        {
            "error": {
                "code": code,
                "message": message,
                "suggested_next_action": suggested_next_action,
            }
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _success(response: BaseModel, summary: str) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=summary)],
        structuredContent=response.model_dump(mode="json", by_alias=True),
    )


def _command_result(response: WorkspaceCommandResponse) -> CallToolResult:
    stdout_bytes = len(response.stdout.encode("utf-8"))
    stderr_bytes = len(response.stderr.encode("utf-8"))
    if response.action == "list":
        summary = f"Listed {len(response.operations)} operation(s)."
    elif response.operation is not None:
        summary = (
            f"Operation {response.operation.operation_id} is {response.operation.state}; "
            f"returned {stdout_bytes} stdout byte(s) and {stderr_bytes} stderr byte(s)."
        )
    else:
        summary = (
            f"Returned {stdout_bytes} stdout byte(s) and {stderr_bytes} stderr byte(s) "
            f"for action={response.action}."
        )
    return _success(response, summary)


def _transport_security(settings: MCPSettings) -> TransportSecuritySettings:
    public = urlsplit(settings.public_url)
    if not public.hostname:
        raise RuntimeError("MCP_PUBLIC_URL must be an absolute URL with a host.")

    public_host = public.hostname
    allowed_hosts = [public_host, f"{public_host}:*"]
    for host in (settings.host, "127.0.0.1", "localhost", "[::1]"):
        if host not in allowed_hosts:
            allowed_hosts.extend([host, f"{host}:*"])

    public_origin = f"{public.scheme}://{public.netloc}"
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=[
            public_origin,
            "http://127.0.0.1:*",
            "http://localhost:*",
            "http://[::1]:*",
        ],
    )
