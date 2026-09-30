# Workspace MCP

面向个人使用的 ChatGPT Web Remote MCP 后端，Linux 原生运行。

它提供持久 Workspace、文件搜索/读取/写入/Patch，以及任意 Bash 命令执行能力。Remote MCP 是唯一业务入口。

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
                    +-- /bin/bash --noprofile --norc -c <script>
                    `-- POSIX session / process group
```

## 设计原则

- 面向单用户、个人部署。
- 一个 MCP 实例对应一个 Linux OS 账户和该账户已有的 `git` / `gh` 登录状态。
- OAuth 只保护 ChatGPT -> MCP 边界，不引入多租户。
- `workspaceCommand` 保留任意 Bash，不做命令白名单。
- Shell command 生命周期与单次 MCP tool call 生命周期分离。
- 快速命令可以在 `start` 中直接完成；长命令保持 operation 状态，通过 `get` 跟进。
- `start` / `get` 直接携带增量 stdout/stderr；`logs` 用于历史重读和分页。
- 文件工具始终限制在对应 Workspace root 内。
- Linux command runner 使用独立 POSIX session/process group 管理普通 descendants。
- 本版本不依赖 PowerShell、Windows Job Object、`kernel32` 或 `taskkill`。
- 当前版本不要求 systemd/service 化，直接运行 `workspace-mcp` 即可。

## MCP Tools

### `prepareWorkspace`

创建持久 Workspace，或者复用已有 `workspace_id`。

创建时使用 `idempotency_key` 生成稳定的 `ws_<16 hex>` ID。同一个 key 会得到同一个 Workspace。

### `workspaceInspect`

第一次进入不熟悉的 Workspace 时使用，返回：

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

创建或覆盖单个 UTF-8 文本文件。

支持：

```text
create_only
overwrite
overwrite_if_sha256_matches
```

同时支持 dry-run、line-ending 控制和 SHA-256 compare-and-write。

`line_ending`：

```text
preserve
lf
crlf
```

Linux 语义：

- 已有 LF 文件 + `preserve` -> 保持 LF；
- 已有 CRLF 文件 + `preserve` -> 保持 CRLF；
- 新文件 + `preserve` -> 默认 LF；
- `lf` / `crlf` -> 显式强制指定行尾。

覆盖已有文件时会保留原 POSIX mode，包括 executable bit，避免把 `0755` 脚本意外写成 `0644`。

### `workspaceApplyPatch`

应用多文件文本 Patch，支持：

- dry-run；
- changed-file limit；
- patch byte limit；
- 可选 delete；
- 事务式提交；
- 提交失败时回滚；
- 保留已有文件主要 LF/CRLF 风格；
- 保留已有文件 POSIX mode/executable bit。

Patch 内部会把文本规范成 LF 进行 hunk 匹配，写回时恢复已有文件的主要行尾风格。mixed newline 文件会规范成主要风格，不保证逐行保持混合行尾。

### `workspaceCommand`

管理任意 Bash command：

```text
workspaceCommand(
    action = start | get | logs | cancel | list,
    ...
)
```

#### `start`

启动：

```text
/bin/bash --noprofile --norc -c <script>
```

核心输入：

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

后端会在短同步窗口内等待快速命令。如果命令已经结束，直接返回终态；仍在运行则返回 `running`。

返回：

```text
operation
stdout
stderr
next_stdout_offset
next_stderr_offset
stdout_eof
stderr_eof
```

operation 中包含：

```text
root_pid
process_group_id
```

Linux runner 使用 `start_new_session=True` 创建独立 session/process group。正常情况下 root Bash 的 PID 同时是 PGID。

#### `get`

跟进运行中的 operation：

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

调用方应把本次返回的 `next_stdout_offset` / `next_stderr_offset` 传给下一次 `get`，避免重复读取。

#### `logs`

显式读取历史日志：

```text
operation_id
stdout_offset
stderr_offset
max_bytes
```

适用于从头重读、指定 offset 补读和大日志分页。

#### `cancel`

请求取消 operation，并清理对应 POSIX process group。

终止顺序：

```text
SIGTERM
  |
  v
等待 kill_grace_seconds
  |
  +-- 进程组退出 -> 完成
  |
  `-- 仍存活 -> SIGKILL
```

timeout 和 MCP shutdown 使用相同的 process-group cleanup 机制。

即使 root Bash 已经正常退出，只要普通后台 descendant 仍留在同一 PGID，operation 完成前也会执行最终清理，避免遗留后台进程。

#### `list`

枚举 operation，可按 state 过滤。

## Bash 权限模型

`workspaceCommand` 是 OS-account-scoped 的任意 Bash 执行入口。

后端不会解析或限制 command，可以运行：

- `git`；
- `gh`；
- Python；
- 测试/构建工具；
- 网络 CLI；
- 项目自定义 CLI；
- 运行 MCP 的 Linux OS 账户有权执行的其他命令。

谁能够成功通过 OAuth 调用这个 MCP，谁就拥有该 Linux OS 账户对应的 Workspace/命令权限。本项目面向个人自用，不提供多租户隔离。

需要明确区分：

- `workspaceReadFiles` / `workspaceWriteFile` / `workspaceApplyPatch` / `workspaceSearch` / `workspaceInspect` 是 **Workspace-scoped 文件工具**，`..`、绝对路径和最终指向 root 外的 symlink 都会被拒绝。
- `workspaceCommand` 是 **OS-account-scoped 任意 Bash**，故意不受 Workspace 文件路径限制。

## Process Group 的已知边界

POSIX process group 能可靠覆盖普通 command descendants，例如：

- git / gh；
- Python；
- pytest / Ruff；
- gcc / clang；
- make / cmake；
- npm/pnpm/yarn；
- 普通项目 CLI。

但 process group 不是安全沙箱。子进程如果主动执行：

- `setsid()`；
- `setpgid()`；
- 传统 daemonize（常见 fork -> setsid -> fork）；
- 某些 supervisor/launcher 的重新建 session 行为；

就可能离开原 PGID，不再受本 operation 的 `killpg()` 控制。

例如：

```bash
setsid some-program &
```

第一版 Linux runner 明确接受这个边界。若未来要求连主动 daemonize/setsid 都不能逃逸，应单独引入 cgroup v2 / systemd scope 等更强 containment；当前版本不包含该能力。

## 文件行尾与 Git

MCP 文件工具不会因为运行在 Linux 就把已有 CRLF 文件无条件转成 LF。

仓库本身还提供 `.gitattributes`，固定 Linux 运行相关文本文件使用 LF，避免开发者在 `core.autocrlf=true` 的 Windows 环境 checkout 后把 shell/shebang 文件带入 CRLF。

关键检查命令：

```bash
git ls-files --eol
```

特别是 shell/shebang 文件应避免出现：

```text
/bin/bash^M: bad interpreter
```

## Authentication

个人部署可以先用 `noauth` 跑通 Remote MCP，后续再增加 OAuth。

规则：

- 没有配置任何 `OAUTH_*` 环境变量：服务使用 `noauth`；
- 一旦开始配置 OAuth，`OAUTH_AUDIENCE`、`OAUTH_ISSUER`、`OAUTH_JWKS_URL`、`OAUTH_ALLOWED_SUBJECT` 必须同时存在。

noauth 时，7 个 tools 在 `tools/list` 中声明：

```json
{"securitySchemes":[{"type":"noauth"}]}
```

### OAuth 2.1

项目采用 Resource Server 模式。登录、Authorization Code + PKCE、client registration 和 token 签发由外部 OAuth/OIDC Provider 负责；本服务验证 Access Token。

服务验证：

- JWT 签名；
- 允许的签名算法；
- issuer；
- audience/resource；
- expiry；
- MCP required scope；
- 固定 `sub`。

启用 OAuth 后，整个 MCP Server 强制 OAuth：initialize 前必须完成认证，缺 Token 返回 401，缺 scope 返回 403。

`tools/list` 中每个 tool 都显式声明顶层 `securitySchemes`，并同步提供 `_meta.securitySchemes` 兼容镜像。

### Auth0 最简配置

个人部署可以使用 Auth0 + Dynamic Client Registration (DCR)。

Auth0 Dashboard：

1. 创建 tenant；
2. `Settings -> Advanced` 开启 Dynamic Client Registration；
3. 开启 Resource Parameter Compatibility Profile；
4. 创建 API，Identifier 作为 `OAUTH_AUDIENCE`；
5. 增加 permission：

   ```text
   workspace:execute
   ```

6. 在 Default Permissions for Third Party Apps 中允许 User-Delegated Access 并授予该 permission；
7. 配置个人登录账号并关闭公开注册；
8. 复制自己的 Auth0 `user_id`，配置为 `OAUTH_ALLOWED_SUBJECT`。

示例：

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

`OAUTH_ISSUER` 必须使用 Provider 的 canonical issuer，并与 Token 中 issuer 精确匹配。

多个个人 MCP 可以共用同一 `OAUTH_AUDIENCE`。这样一个为共享 audience 签发的有效 Token 可以被这些 MCP 接受，因此它们属于同一个私人信任域。

## 环境变量

复制示例：

```bash
cp .env.example .env
```

主要配置：

```text
WORKSPACE_ROOT
WORKSPACE_OPERATION_ROOT
WORKSPACE_SHELL_PATH
WORKSPACE_COMMAND_SYNC_WAIT_SECONDS
WORKSPACE_COMMAND_TIMEOUT_SECONDS
WORKSPACE_COMMAND_MAX_TIMEOUT_SECONDS
WORKSPACE_COMMAND_OUTPUT_BYTES
WORKSPACE_COMMAND_MAX_OUTPUT_BYTES

MCP_PUBLIC_URL
MCP_HOST
MCP_PORT

OAUTH_AUDIENCE
OAUTH_ISSUER
OAUTH_JWKS_URL
OAUTH_ALLOWED_ALGORITHMS
OAUTH_ALLOWED_SUBJECT
MCP_REQUIRED_SCOPE
```

### `WORKSPACE_ROOT`

持久 Workspace 根目录。服务会在其中创建 `ws_*` 目录。

示例：

```env
WORKSPACE_ROOT=/var/lib/workspace-mcp/workspaces
```

### `WORKSPACE_OPERATION_ROOT`

operation 状态和 stdout/stderr 日志目录。未配置时默认：

```text
.runtime/workspace-operations
```

### `WORKSPACE_SHELL_PATH`

默认：

```env
WORKSPACE_SHELL_PATH=/bin/bash
```

目标 shell 必须支持：

```text
--noprofile --norc -c
```

本项目按 Bash 语义实现和测试。

### `MCP_PUBLIC_URL`

ChatGPT 访问的公开 MCP resource URL，例如：

```text
https://mcp.example.com/mcp
https://githubaction.giize.com/mcp-app/mcp
```

允许二级路径，只要求公网 URL 是 HTTPS 且最终以 `/mcp` 结尾。后端本身监听 `/mcp`，可以由 Caddy `handle_path` 剥掉公网前缀。

## Linux 安装

要求：

- Linux；
- Python 3.11+；
- Bash；
- ripgrep (`rg`)；
- 如果要操作 GitHub：`git` 和 `gh`。

示例（Debian/Ubuntu）：

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv ripgrep git
```

安装 Python 项目：

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -U pip
python -m pip install -e ".[dev]"
```

如果需要 GitHub CLI，请按目标 Linux 发行版安装 `gh`，然后使用 **运行 MCP 的同一个 OS 账户** 登录：

```bash
gh auth login
```

`workspaceCommand` 会继承该 OS 账户的环境、文件权限和 CLI 登录状态。

## 直接启动

当前版本不要求注册 systemd service。

配置 `.env` 后直接：

```bash
. .venv/bin/activate
workspace-mcp
```

默认监听：

```text
127.0.0.1:8000
```

正式对 ChatGPT 暴露时，应通过稳定 HTTPS 域名访问：

```text
https://<domain>/mcp
https://<domain>/<prefix>/mcp
```

反向代理需要允许 Streamable HTTP 的长连接/流式响应。

### Caddy 二级路径示例

公网：

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

`handle_path` 会剥掉 `/mcp-app`，公网 `/mcp-app/mcp` 转发到后端 `/mcp`。

OAuth 模式下还必须代理 protected-resource metadata，例如：

```text
https://githubaction.giize.com/.well-known/oauth-protected-resource/mcp-app/mcp
```

## ChatGPT Web 连接

noauth 测试：

1. 在 ChatGPT Web 打开 Developer Mode / Plugin MCP 管理；
2. 添加 Remote MCP URL；
3. Authentication 使用 noauth；
4. 确认 7 个 Workspace tools 可见；
5. 用真实 Workspace 验证读、写、Patch 和 Bash command。

切换 OAuth 后：

1. 在 `.env` 增加 `OAUTH_*` 配置并重启进程；
2. 确保反向代理包含 protected-resource metadata；
3. 确认 metadata 中 `resource` 精确等于 `OAUTH_AUDIENCE`；
4. 在 ChatGPT 中重新连接并选择 OAuth；
5. 完成 Provider 登录/授权；
6. 再次确认 7 个 tools 和 `workspaceCommand`。

## 验证

Linux 上运行：

```bash
python -m ruff check .
python -m pytest -q
```

建议同时检查：

```bash
git ls-files --eol
```

真实端到端验收应覆盖：

- MCP initialize；
- 7 个 tools discovery；
- OAuth challenge（OAuth 模式）；
- Workspace create/reuse；
- inspect/search/read；
- write/patch；
- LF/CRLF 保持；
- executable bit 保持；
- Bash quick command；
- 长任务 `start -> get`；
- stdout/stderr offset；
- timeout；
- cancel；
- MCP shutdown；
- background child cleanup；
- UTF-8 chunk boundary；
- ANSI 清理；
- `setsid()` 已知逃逸边界。

## 测试覆盖

测试重点覆盖：

- 7 个 MCP tools discovery/schema/annotations/structured output；
- OAuth/JWT 和 protected-resource metadata；
- Workspace root path/symlink containment；
- inspect/search/read；
- write/hash/dry-run；
- Patch transaction/rollback；
- LF/CRLF preserve；
- POSIX mode/executable-bit preserve；
- bounded output；
- Bash quick start；
- 增量日志和 offset；
- UTF-8 多字节分页和 partial pipe write；
- ANSI escape 分块清理；
- idempotency；
- timeout；
- cancel；
- shutdown；
- SIGTERM grace period；
- SIGKILL escalation；
- root Bash 退出后的同 PGID descendant cleanup；
- `setsid()` 逃逸边界。

## 官方参考

- OpenAI Plugin / MCP server: https://developers.openai.com/plugins/build/mcp-server
- OpenAI Plugin authentication: https://developers.openai.com/plugins/build/auth
- OpenAI connect ChatGPT: https://developers.openai.com/plugins/deploy/connect-chatgpt
- MCP Python SDK: https://github.com/modelcontextprotocol/python-sdk
