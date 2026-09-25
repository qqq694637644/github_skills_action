from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any, Literal
from urllib.parse import urlsplit

import uvicorn
from mcp.server import MCPServer
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import ToolAnnotations
from pydantic import AnyHttpUrl, ValidationError

from .auth import JWTTokenVerifier
from .config import MCPSettings
from .logging import command_for_log, log_error, log_event
from .models import (
    OperationState,
    PrepareWorkspaceRequest,
    PrepareWorkspaceResponse,
    WorkspaceApplyPatchRequest,
    WorkspaceApplyPatchResponse,
    WorkspaceCommandRequest,
    WorkspaceCommandResponse,
    WorkspaceInspectRequest,
    WorkspaceInspectResponse,
    WorkspaceOperationSummary,
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
    oauth_meta = {"securitySchemes": [{"type": "oauth2", "scopes": [settings.required_scope]}]}

    @asynccontextmanager
    async def lifespan(_: MCPServer):
        try:
            yield None
        finally:
            await service.shutdown()

    server = MCPServer(
        name="workspace-mcp",
        title="Personal Remote Workspace",
        description="Persistent workspace tools with arbitrary PowerShell execution.",
        version="1.0.0",
        instructions=SERVER_INSTRUCTIONS,
        token_verifier=JWTTokenVerifier(settings),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(settings.issuer),
            resource_server_url=AnyHttpUrl(settings.public_url),
            required_scopes=[settings.required_scope],
            # JWTTokenVerifier validates the configured audience itself. Keeping this
            # false also supports providers whose API audience is not the public MCP URL.
            validate_token_resource=False,
        ),
        lifespan=lifespan,
    )

    @server.tool(
        name="prepareWorkspace",
        title="Prepare workspace",
        description=(
            "Create an empty persistent workspace or reuse an existing workspace_id. "
            "Repository and branch state are not managed implicitly."
        ),
        annotations=_PREPARE,
        meta=oauth_meta,
    )
    async def prepare_workspace(
        idempotency_key: str | None = None,
        workspace_id: str | None = None,
    ) -> PrepareWorkspaceResponse:
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
            return response
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceInspect",
        title="Inspect workspace",
        description=(
            "First pass for unfamiliar workspace paths. Returns a bounded tree plus optional "
            "literal search matches and matching file snippets."
        ),
        annotations=_READ_ONLY,
        meta=oauth_meta,
    )
    async def workspace_inspect(
        workspace_id: str,
        paths: list[str] | None = None,
        queries: list[str] | None = None,
        max_depth: int = 2,
        max_tree_entries: int = 200,
        context_lines: int = 2,
        max_search_matches: int = 50,
        max_read_files: int = 10,
        max_file_lines: int = 120,
        max_bytes_per_file: int | None = None,
        max_bytes: int | None = None,
    ) -> WorkspaceInspectResponse:
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
            return WorkspaceInspectResponse.model_validate(
                await service.inspect(**request.model_dump())
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceSearch",
        title="Search workspace",
        description=(
            "Primary locator for code or text when the exact file is unknown. Literal search is "
            "the default; set regex=true for ripgrep regular expressions."
        ),
        annotations=_READ_ONLY,
        meta=oauth_meta,
    )
    async def workspace_search(
        workspace_id: str,
        query: str,
        regex: bool = False,
        case_sensitive: bool = False,
        paths: list[str] | None = None,
        context_lines: int = 2,
        max_matches: int = 100,
        max_bytes: int | None = None,
    ) -> WorkspaceSearchResponse:
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
            return WorkspaceSearchResponse.model_validate(
                await service.search(**request.model_dump())
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceReadFiles",
        title="Read workspace files",
        description=(
            "Read bounded UTF-8 content from exact known files. Use inspect/search first "
            "when paths are not yet known."
        ),
        annotations=_READ_ONLY,
        meta=oauth_meta,
    )
    async def workspace_read_files(
        workspace_id: str,
        paths: list[str],
        start_line: int = 1,
        max_lines: int = 200,
        max_bytes_per_file: int | None = None,
        max_bytes: int | None = None,
    ) -> WorkspaceReadFilesResponse:
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
            return WorkspaceReadFilesResponse.model_validate(
                await service.read_files(**request.model_dump())
            )
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceWriteFile",
        title="Write workspace file",
        description=(
            "Create or replace one known UTF-8 text file. Supports create-only, overwrite, "
            "hash-checked overwrite, dry-run, and line-ending control."
        ),
        annotations=_WRITE,
        meta=oauth_meta,
    )
    async def workspace_write_file(
        workspace_id: str,
        path: str,
        content: str,
        mode: Literal["create_only", "overwrite", "overwrite_if_sha256_matches"] = "create_only",
        encoding: Literal["utf-8"] = "utf-8",
        line_ending: Literal["preserve", "lf", "crlf"] = "preserve",
        expected_sha256: str | None = None,
        dry_run: bool = False,
        max_bytes: int | None = None,
    ) -> WorkspaceWriteFileResponse:
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
            return response
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceApplyPatch",
        title="Apply workspace patch",
        description=(
            "Apply a bounded multi-file text patch with optional dry-run and delete permission. "
            "Changes are committed atomically with rollback on failure."
        ),
        annotations=_WRITE,
        meta=oauth_meta,
    )
    async def workspace_apply_patch(
        workspace_id: str,
        patch: str,
        dry_run: bool = False,
        allow_delete: bool = False,
        max_changed_files: int | None = None,
        max_patch_bytes: int | None = None,
    ) -> WorkspaceApplyPatchResponse:
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
            return response
        except WorkspaceToolError as exc:
            raise _tool_error(exc) from exc

    @server.tool(
        name="workspaceCommand",
        title="Run or manage PowerShell",
        description=(
            "Run arbitrary PowerShell 7 work in a persistent workspace. start returns logs after a "
            "short synchronous window; running operations are followed with get, which waits "
            "briefly for state/log changes and returns incremental stdout/stderr. logs rereads "
            "historical output; cancel stops the process tree; list enumerates operations."
        ),
        annotations=_COMMAND,
        meta=oauth_meta,
    )
    async def workspace_command(
        action: Literal["start", "get", "logs", "cancel", "list"],
        idempotency_key: str | None = None,
        workspace_id: str | None = None,
        script: str | None = None,
        timeout_seconds: int | None = None,
        max_output_bytes: int | None = None,
        plain_output: bool = False,
        utf8_output: bool = True,
        operation_id: str | None = None,
        stdout_offset: int = 0,
        stderr_offset: int = 0,
        max_bytes: int = 50_000,
        wait_seconds: float = 5.0,
        state: OperationState | None = None,
    ) -> WorkspaceCommandResponse:
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
                return WorkspaceCommandResponse(action="start", operation=operation, **result)
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
                return WorkspaceCommandResponse(action="get", operation=operation, **result)
            if action == "logs":
                assert request.operation_id is not None
                logs = await service.command_logs(
                    request.operation_id,
                    stdout_offset=request.stdout_offset,
                    stderr_offset=request.stderr_offset,
                    max_bytes=request.max_bytes,
                )
                return WorkspaceCommandResponse(action="logs", **logs)
            if action == "cancel":
                assert request.operation_id is not None
                operation = WorkspaceOperationSummary.model_validate(
                    await service.command_cancel(request.operation_id)
                )
                return WorkspaceCommandResponse(action="cancel", operation=operation)
            operations = [
                WorkspaceOperationSummary.model_validate(item)
                for item in await service.command_list(request.state)
            ]
            return WorkspaceCommandResponse(action="list", operations=operations)
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
