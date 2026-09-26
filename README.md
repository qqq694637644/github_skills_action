# Workspace MCP

面向个人使用的 ChatGPT Web Remote MCP 后端。

它提供一个持久 Workspace，以及文件搜索、读取、写入、Patch 和任意 PowerShell 7 执行能力。Remote MCP 是唯一业务入口。

## 架构

```text
ChatGPT Web
    |
    | OAuth 2.1 + Remote MCP / Streamable HTTP
    v
https://<domain>/mcp
    |
    v
workspace_mcp.server
    |
    +-- prepareWorkspace
    +-- workspaceInspect
    +-- workspaceSearch
    +-- workspaceReadFiles
    +-- workspaceWriteFile
    +-- workspaceApplyPatch
    `-- workspaceCommand
            |
            v
      LocalWorkspaceService
            |
            +-- WorkspaceRegistry
            +-- 文件 / 搜索 / Patch
            `-- WorkspaceOperationManager
                    |
                    `-- 任意 PowerShell / git / gh / Python / 项目 CLI
```

## 设计原则

- 单用户、个人部署。
- 一个 MCP 服务实例对应一个 OS 账户和一套现有 `git` / `gh` 登录状态。
- OAuth 只负责保护 ChatGPT -> MCP 边界，不引入多租户。
- `workspaceCommand` 保留任意 PowerShell，不做命令白名单。
- PowerShell 生命周期和单次 MCP tool call 生命周期分离。
- 快速命令可以在 `start` 中直接完成；长命令继续后台运行，通过 `get` 跟进。
- `start` / `get` 直接携带增量 stdout/stderr，正常流程不需要额外调用 `logs`。
- `logs` 只用于历史日志重读、指定 offset 补读和大日志分页。

## MCP Tools

### `prepareWorkspace`

创建一个持久 Workspace，或者复用已存在的 `workspace_id`。

创建时使用 `idempotency_key` 生成稳定的 `ws_<16 hex>` ID。同一个 key 会得到同一个 Workspace。

### `workspaceInspect`

第一次进入不熟悉的 Workspace 时使用。返回：

- 有界目录树；
- 可选 literal 搜索结果；
- 命中文件的有界内容；
- 截断标记。

### `workspaceSearch`

使用 ripgrep 搜索 Workspace。

默认 literal、忽略大小写；可启用 regex 和大小写敏感模式。结果包含路径、行号、列号、命中行和上下文片段。

### `workspaceReadFiles`

读取已知 UTF-8 文本文件，支持：

- `start_line`；
- `max_lines`；
- 单文件 byte limit；
- 整体 response byte limit；
- SHA-256；
- `next_start_line` continuation。

### `workspaceWriteFile`

创建或覆盖单个文本文件。

支持：

```text
create_only
overwrite
overwrite_if_sha256_matches
```

同时支持 dry-run、line ending 控制和 SHA-256 compare-and-write。

### `workspaceApplyPatch`

应用多文件文本 Patch。

支持：

- dry-run；
- changed-file limit；
- patch byte limit；
- 可选 delete；
- 事务式提交；
- 提交失败时回滚。

### `workspaceCommand`

统一管理任意 PowerShell 7 命令：

```text
workspaceCommand(
    action = start | get | logs | cancel | list,
    ...
)
```

#### `start`

启动 PowerShell command。

输入核心字段：

```text
idempotency_key
workspace_id
script
timeout_seconds
max_output_bytes
plain_output
utf8_output
stdout_offset
stderr_offset
max_bytes
```

后端会在一个短同步窗口内等待快速命令。如果命令已经结束，直接返回终态；如果仍在运行，则返回 `running`。

无论是否结束，`start` 都同时返回当前已有日志：

```text
operation
stdout
stderr
next_stdout_offset
next_stderr_offset
stdout_eof
stderr_eof
```

#### `get`

跟进运行中的 operation。

输入：

```text
operation_id
wait_seconds
stdout_offset
stderr_offset
max_bytes
```

`get` 会等待以下任一事件：

1. operation 进入终态；
2. stdout 从指定 offset 后产生新数据；
3. stderr 从指定 offset 后产生新数据；
4. `wait_seconds` 到期。

然后一次性返回状态和增量日志。

正常长任务流程：

```text
start
  -> operation_id + 首批日志 + next offsets

get(offsets...)
  -> state + 新日志 + next offsets

get(offsets...)
  -> state + 新日志 + next offsets

...

terminal state
```

调用方应把每次返回的 `next_stdout_offset` / `next_stderr_offset` 传给下一次 `get`，这样不会重复读取旧日志。

`wait_seconds` 默认 5 秒，最大 30 秒。它只是一次 follow call 的 bounded wait，不是 command timeout。

#### `logs`

显式读取历史日志：

```text
operation_id
stdout_offset
stderr_offset
max_bytes
```

适合：

- 从头重新看日志；
- 从任意 offset 补读；
- 大日志分页；
- 之前因为 `max_bytes` 截断后继续读取。

#### `cancel`

请求取消 operation，并终止对应 PowerShell process tree。

#### `list`

枚举 operation，可按 state 过滤。

## PowerShell 权限模型

`workspaceCommand` 是任意 PowerShell 执行入口。

后端不会解析或限制命令，可以运行：

- `git`；
- `gh`；
- Python；
- 测试和构建工具；
- 网络 CLI；
- 项目自定义 CLI；
- 运行服务的 OS 账户有权执行的其他 PowerShell 操作。

因此，谁能够成功通过 OAuth 调用这个 MCP，谁就拥有该服务 OS 账户对应的 Workspace/命令权限。

本项目面向个人自用，不提供多租户隔离。

这里需要明确区分两类能力：

- `workspaceReadFiles` / `workspaceWriteFile` / `workspaceApplyPatch` / `workspaceSearch` / `workspaceInspect` 是 **Workspace-scoped 文件工具**，路径必须解析后仍位于对应 Workspace root 内；`..`、绝对路径以及最终指向 root 外的 symlink/junction 都会被拒绝。
- `workspaceCommand` 是 **故意设计成 OS-account-scoped 的任意 PowerShell**，不受 Workspace 文件路径限制，可以访问运行服务的 OS 账户本来就能访问的一切。这是正式能力，不是安全漏洞或待收紧项。

## OAuth 2.1

Remote MCP 不提供 `noauth` 或旧静态 Bearer Token 模式。

项目采用 Resource Server 模式：登录、Authorization Code + PKCE、client registration 和 token 签发由外部 OAuth/OIDC Provider 负责；本服务负责验证 Access Token。

```text
ChatGPT Web
    |
    | Authorization Code + PKCE S256
    v
OAuth/OIDC Provider
    |
    | Access Token
    v
Workspace MCP Resource Server
```

服务会验证：

- JWT 签名；
- 允许的签名算法；
- issuer；
- audience/resource；
- expiry；
- MCP required scope；
- 固定 `sub`，用于只允许自己的账号。

MCP Python SDK 会根据 Resource Server 配置暴露 protected-resource metadata，并在未认证请求上返回标准 `WWW-Authenticate` challenge。

本项目采用**整个 MCP Server 强制 OAuth**的模式：客户端在 `/mcp` initialize 之前就必须完成认证，缺 Token 返回 401，缺 scope 返回 403。因此不使用“匿名连接成功后，再由某个 tool 返回 `_meta["mcp/www_authenticate"]`”的工具级混合认证流程。所有 7 个 tools 继承同一个 server-level OAuth 边界。

同时，`tools/list` 中每个 tool 都显式声明顶层 `securitySchemes`，并同步提供 `_meta.securitySchemes` 兼容镜像；两者都声明 `oauth2 + workspace:execute`。这样 ChatGPT 看到的 tool descriptor 与整个 server 的 OAuth 策略一致。

### OAuth Provider 要求

Provider 至少需要满足 ChatGPT Remote MCP 的 OAuth client 接入要求，并支持：

- Authorization Code；
- PKCE S256；
- 正确的 OAuth/OIDC metadata；
- JWT/JWKS；
- 为 MCP resource/audience 签发 Token；
- ChatGPT 使用的 client registration 方式（按 Provider 选择 CIMD、DCR 或预定义 client）。

ChatGPT 中实际使用的 redirect URI 应以 ChatGPT MCP 管理界面显示的值为准，并配置到 Provider。

## 环境变量

复制：

```powershell
Copy-Item .env.example .env
```

主要配置：

```text
WORKSPACE_ROOT
WORKSPACE_OPERATION_ROOT
WORKSPACE_PWSH_PATH
WORKSPACE_COMMAND_SYNC_WAIT_SECONDS
WORKSPACE_COMMAND_TIMEOUT_SECONDS
WORKSPACE_COMMAND_MAX_TIMEOUT_SECONDS
WORKSPACE_COMMAND_OUTPUT_BYTES
WORKSPACE_COMMAND_MAX_OUTPUT_BYTES

MCP_PUBLIC_URL
MCP_HOST
MCP_PORT

OAUTH_ISSUER
OAUTH_JWKS_URL
OAUTH_ALLOWED_ALGORITHMS
OAUTH_ALLOWED_SUBJECT
MCP_REQUIRED_SCOPE
```

### `WORKSPACE_ROOT`

持久 Workspace 根目录。服务会在其中创建 `ws_*` 目录。

### `WORKSPACE_OPERATION_ROOT`

operation 状态和 stdout/stderr 日志目录。未配置时默认：

```text
.runtime/workspace-operations
```

### `MCP_PUBLIC_URL`

ChatGPT 访问的公开 MCP resource URL，例如：

```text
https://mcp.example.com/mcp
```

### OAuth resource / audience

`MCP_PUBLIC_URL` 就是唯一 canonical MCP resource，同时也是 JWT 必须包含的 audience。项目不提供额外的 `OAUTH_AUDIENCE` 兼容层；OAuth Provider 必须为这个 MCP resource 签发 Token。

### `OAUTH_ISSUER`

必须使用 Provider discovery metadata 中公布的规范 issuer，字符串要精确一致。不要自行增加或删除尾部 `/`。对于只有 host 的 issuer，如果 Provider 公布的是带尾 `/` 的值，就必须保持该 `/`。

### `OAUTH_ALLOWED_SUBJECT`

必填。只有 JWT `sub` 完全匹配的 Token 才会被接受，用来把这个个人 MCP 固定到自己的 Provider 账号。

## 安装

要求：

- Python 3.11+；
- PowerShell 7 (`pwsh`)；
- ripgrep (`rg`)；
- 如果要操作 GitHub：`git` 和 `gh`。

安装：

```powershell
python -m pip install -e ".[dev]"
```

如果需要 GitHub CLI：

```powershell
gh auth login
```

MCP Server 会继承启动它的 OS 账户环境，因此 `gh` 使用该账户已有的登录状态。

## 启动

配置 `.env` 后：

```powershell
workspace-mcp
```

默认监听：

```text
127.0.0.1:8000
```

正式部署时应通过稳定 HTTPS 域名暴露：

```text
https://<domain>/mcp
```

如果使用反向代理，需要允许 Streamable HTTP 的长连接/流式响应，不要把 `/mcp` 当普通短请求接口处理。

## MCP Protected Resource Metadata

当：

```text
MCP_PUBLIC_URL=https://mcp.example.com/mcp
```

SDK 会暴露与该 resource 对应的 protected-resource metadata，例如：

```text
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

未携带有效 Token 访问 `/mcp` 会得到 HTTP 401 和 `WWW-Authenticate` challenge，引导客户端发现 OAuth metadata。

## ChatGPT Web 连接

部署和 OAuth Provider 配置完成后：

1. 在 ChatGPT Web 打开 Developer Mode / Plugin MCP 管理；
2. 添加 Remote MCP URL：`https://<domain>/mcp`；
3. 按界面完成 OAuth 授权；
4. 确认 ChatGPT 能发现 7 个 Workspace tools；
5. 用真实 Workspace 流程验证读、写、Patch 和 PowerShell。

本项目不负责网页版 Skill 注册；Skill 与后端 MCP 是两个独立层面。

## 验证

运行测试：

```powershell
python -m pytest -q
```

运行 lint：

```powershell
python -m ruff check .
```

格式化：

```powershell
python -m ruff format .
```

在连接 ChatGPT 之前，建议先使用 MCP Inspector 检查：

- initialize；
- tool discovery；
- input/output schema；
- OAuth challenge；
- Workspace tool 调用。

最终仍需要从真实 ChatGPT Web 完成 OAuth + Remote MCP 端到端验证。

## 测试覆盖

当前测试重点覆盖：

- 7 个 MCP tools discovery/schema/annotations/structured output；
- `tools/list` wire response 的顶层 `securitySchemes` 与 `_meta.securitySchemes` 镜像；
- structuredContent 与短文本 content 不重复大块文件/日志；
- OAuth protected-resource metadata、401 challenge 和 403 scope challenge；
- JWT 签名、issuer、canonical MCP resource/audience、expiry/nbf、subject；
- Workspace create/reuse；
- Workspace 文件工具的 `..` / 绝对路径 / symlink-junction root containment；
- `workspaceCommand` 仍可按设计访问 Workspace root 外的 OS-account-scoped 路径；
- inspect/search/read；
- write/hash/dry-run；
- patch transaction/rollback；
- bounded output；
- PowerShell quick start；
- 长任务 `start -> get` 增量日志；
- 日志 offset 不重复；
- UTF-8 中文/Emoji 即使按 1 byte 分页也不会损坏；
- `logs` 历史补读；
- idempotency；
- timeout；
- cancel；
- operation list。

## 官方参考

- OpenAI Plugin / MCP server: https://developers.openai.com/plugins/build/mcp-server
- OpenAI Plugin authentication: https://developers.openai.com/plugins/build/auth
- OpenAI connect ChatGPT: https://developers.openai.com/plugins/deploy/connect-chatgpt
- MCP Python SDK: https://github.com/modelcontextprotocol/python-sdk
