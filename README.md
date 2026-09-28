# Workspace MCP

面向个人使用的 ChatGPT Web Remote MCP 后端。

它提供一个持久 Workspace，以及文件搜索、读取、写入、Patch 和任意 PowerShell 7 执行能力。Remote MCP 是唯一业务入口。

## 架构

```text
ChatGPT Web
    |
    | Remote MCP / Streamable HTTP
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

同时支持 dry-run、line ending 控制和 SHA-256 compare-and-write。选择
`overwrite_if_sha256_matches` 时，MCP schema 和运行时校验都会要求
`expected_sha256`。

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

## Authentication

个人部署可以先用 `noauth` 把 Remote MCP 跑通，后续再增加 OAuth。

规则很简单：

- **没有配置任何 `OAUTH_*` 环境变量**：服务使用 `noauth`；
- **开始配置 OAuth 后**：`OAUTH_AUDIENCE`、`OAUTH_ISSUER`、`OAUTH_JWKS_URL`、`OAUTH_ALLOWED_SUBJECT` 必须同时存在。

noauth 时，7 个 tools 会在 `tools/list` 中声明：

```json
{"securitySchemes":[{"type":"noauth"}]}
```

### OAuth 2.1（后续启用）

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

启用 OAuth 后，整个 MCP Server 强制 OAuth：客户端在 `/mcp` initialize 之前必须完成认证，缺 Token 返回 401，缺 scope 返回 403。

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

### Auth0 最简配置

个人部署推荐直接使用 Auth0 + Dynamic Client Registration (DCR)。这样不需要手工创建 ChatGPT OAuth Application，也不需要自己维护 client secret；ChatGPT 第一次连接时会自动向 Auth0 注册客户端。

Auth0 Dashboard：

1. 创建一个 Auth0 tenant。
2. `Settings -> Advanced`：
   - 开启 **Dynamic Client Registration**；
   - 开启 **Resource Parameter Compatibility Profile**；
   - 如果界面有 **DCR Security Mode**，使用 `Strict`。
3. `Applications -> APIs -> Create API`：
   - Name: `Private MCP`（名字随意）；
   - Identifier: 作为所有私人 MCP 共用的 **Logical API / audience**。例如可以直接复用你已经创建的 `https://githubaction.giize.com/mcp-app/mcp`；
   - Signing Algorithm: `RS256`。
4. 在这个 API 增加 permission：

   ```text
   workspace:execute
   ```

5. 在这个 API 的 **Default Permissions for Third Party Apps** 中允许 User-Delegated Access，并授予 `workspace:execute`。DCR 创建出来的 ChatGPT client 属于 third-party application；这一步保证它实际拿到所需 scope。
6. `Authentication -> Database -> Username-Password-Authentication`：
   - 创建/使用你的个人登录账号；
   - 关闭公开 Sign Ups；
   - 开启 **Promote Connection to Domain Level**，让动态注册的第三方 client 可以使用这个登录连接。
7. `User Management -> Users` 打开你自己的用户，复制 `user_id`。数据库用户通常类似：

   ```text
   auth0|xxxxxxxxxxxxxxxx
   ```

Auth0 不需要单独创建固定 ChatGPT Application；DCR 会在首次连接时创建并复用 client。

对应 `.env`：

```env
MCP_PUBLIC_URL=https://githubaction.giize.com/mcp-app/mcp
MCP_HOST=127.0.0.1
MCP_PORT=8003

OAUTH_AUDIENCE=https://githubaction.giize.com/mcp-app/mcp
OAUTH_ISSUER=https://YOUR_TENANT_REGION.auth0.com/
OAUTH_JWKS_URL=https://YOUR_TENANT_REGION.auth0.com/.well-known/jwks.json
OAUTH_ALLOWED_SUBJECT=auth0|YOUR_USER_ID
OAUTH_ALLOWED_ALGORITHMS=RS256
MCP_REQUIRED_SCOPE=workspace:execute
```

`OAUTH_ISSUER` 必须使用 Auth0 tenant 的 canonical issuer，并保留尾部 `/`。

Auth0 使用 MCP 的 `resource` 参数。必须开启 **Resource Parameter Compatibility Profile**，这样 Auth0 才会把 ChatGPT 发送的共享 resource：

```text
resource=https://githubaction.giize.com/mcp-app/mcp
```

映射成 Access Token 的 audience。

多个 MCP 共用时，每个项目的 `MCP_PUBLIC_URL` 可以不同，但 `OAUTH_AUDIENCE` 保持相同。例如：

```env
# MCP A
MCP_PUBLIC_URL=https://githubaction.giize.com/mcp-app/mcp
OAUTH_AUDIENCE=https://githubaction.giize.com/mcp-app/mcp

# MCP B
MCP_PUBLIC_URL=https://githubaction.giize.com/files-mcp/mcp
OAUTH_AUDIENCE=https://githubaction.giize.com/mcp-app/mcp

# MCP C
MCP_PUBLIC_URL=https://githubaction.giize.com/server-mcp/mcp
OAUTH_AUDIENCE=https://githubaction.giize.com/mcp-app/mcp
```

这样 Auth0 只需要一个 API；一个为该 shared audience 签发的 Token 可以被所有配置相同 audience、scope 和 subject 的私人 MCP 接受。这是刻意的共享信任边界。

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

OAUTH_AUDIENCE               # optional, OAuth 模式才配置；多个 MCP 可共用
OAUTH_ISSUER                 # optional, OAuth 模式才配置
OAUTH_JWKS_URL               # optional, OAuth 模式才配置
OAUTH_ALLOWED_ALGORITHMS     # optional, OAuth 模式才配置
OAUTH_ALLOWED_SUBJECT        # optional, OAuth 模式才配置
MCP_REQUIRED_SCOPE           # optional, OAuth 模式默认 workspace:execute
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
https://githubaction.giize.com/mcp-app/mcp
```

允许二级路径，只要求公网 URL 是 HTTPS 且最终以 `/mcp` 结尾。后端本身仍监听 `/mcp`；可以由 Caddy `handle_path` 剥掉公网前缀。

### `OAUTH_AUDIENCE`（OAuth 模式）

`MCP_PUBLIC_URL` 只表示这个 MCP 自己的公网连接地址；`OAUTH_AUDIENCE` 表示共享的 OAuth resource / Auth0 API Identifier。

JWT 的 `aud` 必须匹配 `OAUTH_AUDIENCE`。MCP protected-resource metadata 也会把 `OAUTH_AUDIENCE` 发布为 `resource`，让 ChatGPT 在授权流程中请求这个共享 Logical API。

这允许多个个人 MCP 复用同一个 Auth0 API/audience。代价也很明确：同一个有效 Token 可以跨这些 MCP 使用，因此它们被视为同一个私人信任域。

### `OAUTH_ISSUER`（OAuth 模式）

必须使用 Provider discovery metadata 中公布的规范 issuer，字符串要精确一致。不要自行增加或删除尾部 `/`。对于只有 host 的 issuer，如果 Provider 公布的是带尾 `/` 的值，就必须保持该 `/`。

`OAUTH_ISSUER` 和 `OAUTH_JWKS_URL` 都必须是绝对 HTTPS URL；本项目不接受 HTTP OAuth 基础设施配置。

### `OAUTH_ALLOWED_SUBJECT`（OAuth 模式）

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
https://<domain>/<prefix>/mcp
```

如果使用反向代理，需要允许 Streamable HTTP 的长连接/流式响应，不要把 `/mcp` 当普通短请求接口处理。

### Caddy 二级路径示例

例如公网地址：

```text
https://githubaction.giize.com/mcp-app/mcp
```

Caddy：

```caddyfile
githubaction.giize.com {
    handle /.well-known/oauth-protected-resource/mcp-app/mcp {
        reverse_proxy 127.0.0.1:8003
    }

    handle_path /mcp-app/* {
        reverse_proxy 127.0.0.1:8003
    }
}
```

`handle_path` 会剥掉 `/mcp-app`，因此公网 `/mcp-app/mcp` 会转发到后端 `/mcp`。

OAuth 模式下还必须代理 protected-resource metadata：

```text
https://githubaction.giize.com/.well-known/oauth-protected-resource/mcp-app/mcp
```

这条路径不能放进 `/mcp-app/*` 的 `handle_path`，因为它位于域名根路径的 `/.well-known/` 下。

## MCP Protected Resource Metadata（OAuth 模式）

当：

```text
MCP_PUBLIC_URL=https://githubaction.giize.com/files-mcp/mcp
OAUTH_AUDIENCE=https://githubaction.giize.com/mcp-app/mcp
```

SDK 会按共享 `OAUTH_AUDIENCE` 暴露 protected-resource metadata，例如：

```text
https://githubaction.giize.com/.well-known/oauth-protected-resource/mcp-app/mcp
```

其中 JSON 的 `resource` 也是 `https://githubaction.giize.com/mcp-app/mcp`，而不是 `files-mcp` 的公网 URL。

未携带有效 Token 访问 `/mcp` 会得到 HTTP 401 和 `WWW-Authenticate` challenge，引导客户端发现 OAuth metadata。

## ChatGPT Web 连接

noauth 测试时：

1. 在 ChatGPT Web 打开 Developer Mode / Plugin MCP 管理；
2. 添加 Remote MCP URL，例如 `https://githubaction.giize.com/mcp-app/mcp`；
3. 不需要 OAuth 授权；
4. 确认 ChatGPT 能发现 7 个 Workspace tools；
5. 用真实 Workspace 流程验证读、写、Patch 和 PowerShell。

切换 Auth0 后：

1. 在 `.env` 增加 Auth0 的 `OAUTH_*` 配置并重启 `workspace-mcp`；
2. 更新 Caddy，增加上面的 `/.well-known/oauth-protected-resource/mcp-app/mcp` 代理；
3. 先访问共享 metadata URL，确认返回的 `resource` 精确等于 `OAUTH_AUDIENCE`；
4. ChatGPT 中删除/重新创建当前 noauth MCP connection，Authentication 选择 `OAuth`；
5. ChatGPT 会通过 Auth0 DCR 自动注册 client，并跳转 Auth0 Universal Login；
6. 使用你自己的 Auth0 用户登录并授权；
7. 授权完成后确认 7 个 tools 仍然可见，并测试 `workspaceCommand`。

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
- path/query 数组的每个元素都有明确长度约束；
- hash-checked overwrite 的 `expected_sha256` 条件写入 tool schema；
- `workspaceCommand` schema 的 timeout/output maximum 来自当前运行时配置；
- OAuth protected-resource metadata、401 challenge 和 403 scope challenge；
- JWT 签名、issuer、共享 audience、expiry/nbf、subject；
- 不同 `MCP_PUBLIC_URL` 可以接受同一个 shared-audience Token；
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
- running PowerShell 即使把一个 UTF-8 code point 分多次写入 pipe，`start -> get`
  也不会提前消费 partial bytes 或产生 replacement character；
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
