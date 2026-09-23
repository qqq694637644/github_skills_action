# ChatGPT Web MCP Migration Plan

## Goal

Migrate the current Custom GPT Actions integration to a ChatGPT Web remote MCP integration while preserving the backend behavior that is already stable in personal use.

This is a transport/authentication migration, not a redesign of the workspace execution model.

## Non-goals

- Do not register or redesign `github-maintenance` as a native ChatGPT Web Skill as part of this migration.
- Do not replace arbitrary PowerShell with narrow command-specific tools.
- Do not split `workspaceCommand(action=start|get|logs|cancel|list)` into separate tools.
- Do not introduce multi-user tenancy, per-user workspaces, or per-user GitHub credentials.
- Do not refactor the workspace engine unless required by MCP compatibility.

## Current behavior that must remain compatible

The following backend behavior is intentionally preserved:

- One persistent workspace root managed by the existing workspace registry.
- One personal service account / OS account.
- Existing `git`, `gh`, Python, build tools, network CLIs, and project tooling available through arbitrary PowerShell.
- Existing workspace file/search/patch behavior.
- Existing operation persistence, timeout, cancellation, log paging, and idempotency behavior.
- `workspaceCommand` remains one tool with the current state machine:

```text
workspaceCommand(
  action = start | get | logs | cancel | list,
  ...
)
```

For long-running commands the expected flow remains:

```text
start -> operation_id -> get/logs -> terminal state
```

No command allowlist or command parser is introduced. The effective command permissions remain those of the service OS account.

## ChatGPT Web MCP requirements that affect this migration

The target integration must follow the current ChatGPT plugin/MCP connection requirements rather than the old Custom GPT Actions model.

### Transport

Use a remote MCP endpoint over Streamable HTTP at a stable HTTPS URL, normally `/mcp`.

For development, Secure MCP Tunnel can be used instead of exposing the local server directly. The normal deployed path should remain a stable remote endpoint if the existing service is already remotely hosted.

### Authentication

Although ChatGPT can connect to anonymous (`noauth`) MCP tools, this backend exposes private workspace state and write/command execution. The migration therefore treats OAuth as required for this project.

Use OAuth 2.1-compatible MCP authorization with authorization-code + PKCE (`S256`).

The MCP resource server must support the authorization discovery flow expected by ChatGPT, including protected-resource metadata and an authorization server that publishes the required OAuth metadata.

At minimum the authentication path must support:

- `/.well-known/oauth-protected-resource` (or equivalent discovery advertised through `WWW-Authenticate`).
- OAuth authorization-server metadata.
- Authorization-code flow with PKCE `S256`.
- Propagation and validation of the MCP `resource` parameter / token audience.
- Access-token verification on MCP requests.
- Tool `securitySchemes` declaring OAuth for the protected tools.
- The MCP OAuth challenge metadata required for ChatGPT to surface account linking when authorization is missing or insufficient.

The old fixed `SKILL_TEMPLE_BEARER_TOKEN` mechanism must not be treated as the ChatGPT MCP authentication mechanism. ChatGPT does not provide an arbitrary custom API-key field for this connection model.

### Personal-use authentication model

OAuth does not imply multi-tenancy for this project.

The first implementation should remain deliberately single-user:

```text
ChatGPT account
    -> OAuth authorization
    -> one MCP deployment
    -> one service OS account
    -> one existing workspace root
    -> one existing gh/git credential context
```

The authorization server may have only one permitted user/account. The resource server still validates tokens correctly, but no tenant abstraction is added to the workspace backend.

Prefer using an established OAuth/OIDC provider that can satisfy the MCP authorization metadata and PKCE requirements. If a minimal self-hosted authorization server is chosen instead, it must still satisfy the same protocol contract; "personal use" is not a reason to fall back to a static bearer token on the ChatGPT-facing endpoint.

## Target architecture

```text
ChatGPT Web
    |
    | MCP Streamable HTTP + OAuth 2.1
    v
Remote MCP endpoint (/mcp)
    |
    v
Thin MCP adapter
    |
    v
WorkspaceActionService / existing transport-independent facade
    |
    v
LocalWorkspaceService
    |-- WorkspaceRegistry
    |-- file/search/patch services
    `-- WorkspaceOperationManager
           `-- arbitrary PowerShell / git / gh / project CLI
```

OAuth belongs at the MCP boundary. Workspace ownership/tenant concepts should not be pushed into the existing backend for this personal deployment.

## Repository changes

### Add

- `src/skill_temple/mcp_server.py` (or equivalent) as the MCP server/transport entry point.
- OAuth resource-server integration for the MCP endpoint.
- Configuration for authorization-server issuer/audience/scopes and the protected-resource metadata URL.
- MCP contract tests.
- Deployment/configuration documentation for connecting the server from ChatGPT Web.

### Reuse with minimal changes

- `src/skill_temple/workspace_registry.py`
- `src/skill_temple/workspace_files.py`
- `src/skill_temple/workspace_patch.py`
- `src/skill_temple/workspace_operations.py`
- `src/skill_temple/workspace_actions.py`
- Existing workspace/regression tests.

`workspace_actions.py` should remain the transport-independent facade if practical. The MCP layer should translate MCP requests/results to the existing service API rather than reimplement workspace behavior.

### Keep unchanged semantically

Expose the existing tool set through MCP:

- `prepareWorkspace`
- `workspaceInspect`
- `workspaceSearch`
- `workspaceReadFiles`
- `workspaceWriteFile`
- `workspaceApplyPatch`
- `workspaceCommand`

Keep the existing `workspaceCommand.action` enum and input/result semantics wherever MCP schema rules permit.

### Retire only after MCP parity is proven

- Custom GPT Actions/OpenAPI transport code that has no remaining caller.
- GPT Actions-only skill-loading endpoints if no retained workflow uses them.
- ChatGPT-page action-log polling endpoints used by the userscript.
- Tampermonkey runtime dependency for normal use.
- Tampermonkey release/publishing workflow if the userscript is not retained as a debugging utility.

Do not delete legacy integration pieces in the first MCP implementation commit. Keep rollback possible until the Web MCP path has been exercised successfully.

## Implementation phases

### Phase 1: MCP transport adapter

1. Add the MCP SDK dependency.
2. Create the Streamable HTTP MCP endpoint.
3. Register the seven existing workspace tools.
4. Route each tool directly into the existing workspace action/service layer.
5. Preserve current request validation, result fields, truncation markers, continuation offsets, and error codes where practical.
6. Keep the old Actions transport available in parallel during migration.

Exit criterion: MCP Inspector can discover and invoke all seven tools against the same backend implementation used by the current Actions API.

### Phase 2: OAuth 2.1 for ChatGPT Web

1. Select the OAuth/OIDC provider or minimal authorization-server implementation.
2. Configure a single permitted personal identity.
3. Publish MCP protected-resource metadata.
4. Publish/consume the required OAuth authorization-server metadata.
5. Configure authorization-code + PKCE `S256`.
6. Ensure the MCP `resource` value is reflected in the issued token audience and validated by the MCP server.
7. Declare OAuth `securitySchemes` on all workspace tools.
8. Return the expected MCP OAuth challenge metadata when the token is absent/invalid/insufficient.
9. Validate issuer, audience, expiry, and required scope(s) on every protected MCP request.

A small scope model is sufficient for personal use. A single scope such as `workspace:execute` is acceptable initially if it covers the whole tool surface and keeps configuration simple.

Exit criterion: ChatGPT Web can complete account linking and subsequently invoke MCP tools with a validated access token; unauthenticated direct calls cannot execute workspace tools.

### Phase 3: Behavioral parity tests

Add MCP-level tests for:

- tool discovery and schemas;
- OAuth-required behavior;
- invalid/expired/wrong-audience token rejection;
- `prepareWorkspace` creation/reuse;
- inspect/search/read;
- write/patch including dry-run and hash mismatch;
- synchronous `workspaceCommand(start)` completion;
- asynchronous `start -> get/logs -> terminal state`;
- `cancel`;
- `list`;
- stdout/stderr continuation offsets and truncation;
- command failure and timeout;
- invalid workspace/operation IDs.

Keep the existing workspace test suite as the primary regression suite. MCP tests should prove adapter/auth correctness, not duplicate all backend unit coverage.

Exit criterion: existing tests still pass and new MCP/auth contract tests pass.

### Phase 4: ChatGPT Web end-to-end validation

From the actual ChatGPT Web plugin connection, exercise representative real workflows:

1. Create/reuse a workspace.
2. Clone or inspect a repository through `workspaceCommand`.
3. Search/read files.
4. Apply a patch.
5. Run tests/build commands.
6. Run `git` and `gh` through arbitrary PowerShell.
7. Start a long-running command and follow it through `get` / `logs`.
8. Cancel a running command.
9. Confirm a later chat/tool call can reuse persistent workspace state as expected.

Exit criterion: the Web MCP path provides the same practical workflow currently provided by GPT Actions, without requiring the userscript.

### Phase 5: Legacy cleanup

Only after Phase 4 succeeds:

1. Make MCP the documented primary integration.
2. Remove/archive Custom GPT Actions/OpenAPI-only transport code no longer used.
3. Remove/archive the userscript path from normal setup.
4. Remove its release workflow if it is no longer needed.
5. Retain backend logging/redaction/operation diagnostics that are useful independently of the userscript.
6. Re-run the full test/lint suite after cleanup.

## Verification commands

At each implementation stage run the most direct checks first, then the full suite:

```powershell
python -m pytest -q
python -m ruff check .
```

Also validate the MCP endpoint with MCP Inspector before testing through ChatGPT Web.

## Migration principles

- Preserve proven behavior before improving architecture.
- Treat arbitrary PowerShell as a required capability, not a temporary escape hatch.
- Treat `workspaceCommand(action=start|get|logs|cancel|list)` as a compatibility contract.
- Keep MCP and OAuth code thin and isolated from the workspace engine.
- Keep the deployment single-user unless requirements actually change.
- Do not make native Skill registration part of this migration.
- Do not remove the old path until the new ChatGPT Web MCP path has been verified end to end.

## Current OpenAI references

- Plugin MCP authentication: https://developers.openai.com/plugins/build/auth
- Build an MCP server: https://developers.openai.com/plugins/build/mcp-server
- Connect and test a plugin in ChatGPT: https://developers.openai.com/plugins/deploy/connect-chatgpt
- Personal plugin quickstart: https://developers.openai.com/plugins/quickstart
