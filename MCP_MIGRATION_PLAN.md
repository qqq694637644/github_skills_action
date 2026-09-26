# ChatGPT 网页版 Remote MCP 破坏式重构计划

## 1. 背景和结论

OpenAI 已宣布 Custom GPT 将退休，标准退休日期为 2026-12-11；Custom GPT 的 Custom Actions 不会自动迁移到 Plugin，依赖 Custom Actions 的能力需要单独重建，典型替代方案就是 Remote MCP。

因此，本项目不再按“兼容升级”处理，而是做一次明确的破坏式重构：

- GPT Actions 彻底退出；
- OpenAPI Actions 网关彻底退出；
- 旧 Skill runtime 彻底退出；
- 油猴监控彻底退出；
- Remote MCP 成为唯一后端接入方式；
- 不保留旧 `/v1/*` Action 接口；
- 不保留旧 Bearer Token Action 认证；
- 不做双轨运行；
- 不做旧版兜底；
- 不为旧 GPT Actions 保持 schema、路由或 CLI 兼容。

这次重构不是“给现有 FastAPI 再套一层 MCP”，而是把仓库从“Skill Temple + GPT Actions Gateway”直接改造成一个单用户 Remote Workspace MCP Server。

## 2. 本次目标

最终只保留一条正式运行链路：

```text
ChatGPT Web
    |
    | Remote MCP / Streamable HTTP
    | OAuth 2.1
    v
Remote MCP Server
    |
    v
Workspace tools
    |
    v
LocalWorkspaceService
    |
    +-- WorkspaceRegistry
    +-- Workspace file/search/patch
    `-- WorkspaceOperationManager
            |
            `-- 任意 PowerShell / git / gh / Python / 项目 CLI
```

目标包括：

1. 使用官方 Python `mcp` SDK 提供 Streamable HTTP MCP 服务；
2. 对外提供稳定 HTTPS `/mcp`；
3. 使用 OAuth 2.1 保护全部 Workspace 工具；
4. 保留现有持久 Workspace 模型；
5. 保留任意 PowerShell；
6. 保留 PowerShell 生命周期与单次 MCP tool call 生命周期分离；
7. 保留现有 operation、timeout、cancel、idempotency、日志分页能力；
8. 优化 `workspaceCommand`，让 `start/get` 直接返回日志，减少远程 MCP 往返；
9. 删除所有 GPT Actions / Skill runtime / userscript 遗留实现；
10. README、配置、测试、包名和 CLI 全部改成 MCP 语义。

## 3. 明确不做的事情

### 3.1 不处理网页版 Skill 注册

`github-maintenance` Skill 如何在 ChatGPT 网页版注册，不属于这个后端仓库的迁移范围。

这个仓库只负责 Remote MCP 后端。

因此不在本计划中实现：

- Skill 注册；
- Skill 打包；
- Skill 自动发现；
- `loadSkills`；
- `readSkillContent`；
- Skill catalog；
- GPT Instructions 编译。

### 3.2 不限制 PowerShell

`workspaceCommand` 继续执行任意 PowerShell，不增加命令白名单，不替换成固定 GitHub API 工具集。

继续允许：

- `git`；
- `gh`；
- Python；
- pytest / Ruff / build；
- 任意项目 CLI；
- 网络 CLI；
- 多条 PowerShell 组合；
- 当前 OS 账户有权执行的其他命令。

权限边界仍然是运行 MCP Server 的操作系统账户及其现有环境、凭据和 CLI 登录状态。

这个权限模型只适用于 `workspaceCommand`。文件类 Workspace tools 仍然是 root-scoped：所有用户提供的文件/目录路径在解析 `..`、绝对路径、symlink/junction 后都必须位于对应 Workspace root 内。文件工具的 root containment 与任意 PowerShell 的 OS-account 权限是两条刻意不同的边界。

### 3.3 不做多租户

这是个人自用服务。

不引入：

- tenant；
- user -> workspace 映射；
- 每用户 GitHub 凭据；
- 每用户 Workspace 根目录；
- 多用户权限模型。

OAuth 只负责确认调用 MCP 的 ChatGPT 客户端已经完成授权，不改变 Workspace 内部模型。

### 3.4 不考虑 MCP Server 重启恢复正在运行的 PowerShell

本次不设计跨 Server restart 的 command recovery。

现有运行中 operation 在进程结束后的处理方式不是这次重构目标，也不为它增加额外基础设施。

## 4. 现有仓库的全局处理结果

当前仓库混合了四类职责：

1. Skill runtime；
2. GPT Actions HTTP/OpenAPI gateway；
3. Workspace 执行内核；
4. 油猴监控。

重构后只保留第 3 类，并新增 Remote MCP + OAuth 边界。

### 4.1 保留的核心实现

以下能力继续作为新项目核心：

```text
workspace_registry.py
workspace_files.py
workspace_patch.py
workspace_operations.py
```

保留的具体行为包括：

- `ws_*` 持久 Workspace；
- 文件读取；
- 文本搜索；
- inspect；
- 安全文本写入；
- sha256 compare-and-write；
- multi-file patch；
- patch dry-run；
- operation id；
- command idempotency；
- PowerShell 子进程；
- timeout；
- process-tree cancel；
- stdout/stderr 独立文件；
- stdout/stderr offset 分页；
- output byte limit；
- ANSI 清理；
- secret redact。

这些能力应保持 transport-independent，不直接依赖 ChatGPT、HTTP route 或 MCP SDK。

### 4.2 删除的 GPT Actions / Skill runtime 代码

以下内容在最终版本中删除，不保留兼容入口：

```text
GPT_ACTION_PROMPT.md
src/skill_temple/app.py
src/skill_temple/openapi_builder.py
src/skill_temple/prompt_builder.py
src/skill_temple/evals.py
src/skill_temple/example_skills/
evals/
```

`runtime.py` 也不再保留 Skill runtime 职责。

其中真正仍被 Workspace 使用的 `.env` 读取逻辑先抽到独立配置模块，再删除 `runtime.py`。

删除：

- `SkillRuntime`；
- Skill frontmatter 扫描；
- Skill path 解析；
- catalog；
- `loadSkills`；
- `readSkillContent`；
- Prompt builder；
- OpenAPI builder；
- Skill eval CLI。

### 4.3 删除的 GPT Actions HTTP 接口

最终版本不再提供：

```text
/openapi.json
/v1/skills
/v1/skills/load
/v1/skills/read
/v1/workspace/prepare
/v1/workspace/inspect
/v1/workspace/search
/v1/workspace/read-files
/v1/workspace/write-file
/v1/workspace/apply-patch
/v1/workspace/command
/console
/console/load
/console/read
/v1/action-logs
```

Workspace 功能只通过 MCP tools 暴露。

如果部署需要简单 health check，可以单独保留一个不承载业务语义的 `/health`，但它不是旧 Actions 兼容接口。

### 4.4 删除油猴相关实现

最终版本删除：

```text
userscripts/
.github/workflows/publish-gpt-action-monitor.yml
```

同时删除只服务于油猴监控的后端逻辑：

- in-memory action event queue；
- `ACTION_EVENT_LIMIT`；
- `wait_for_action_events`；
- `/v1/action-logs`；
- activity monitor 专用事件结构；
- userscript profile / GPT 名称匹配逻辑。

### 4.5 保留并重构日志脱敏能力

`action_logging.py` 不能整文件删除，因为其中仍有通用价值：

- `redact_text`；
- `sensitive_environment_values`；
- `command_for_log`；
- 简洁 command/error 日志。

把这些能力迁到新的普通服务日志模块，例如：

```text
src/workspace_mcp/logging.py
```

删除所有 `ACTION` / legacy monitor 命名，不再维护前端事件缓冲区。

## 5. 包结构和命名一起清理

既然是破坏式重构，不继续保留已经失去意义的 `skill_temple` 包名和 `skill-temple` CLI。

建议改为：

```text
src/workspace_mcp/
    __init__.py
    server.py
    auth.py
    config.py
    models.py
    logging.py
    workspace_registry.py
    workspace_files.py
    workspace_patch.py
    workspace_operations.py
```

项目名/CLI 同步改成：

```text
package: workspace-mcp
module:  workspace_mcp
cli:     workspace-mcp
```

GitHub 仓库本身是否改名可以单独决定，不作为这次代码重构的前置条件。

## 6. 新 MCP Server

### 6.1 MCP SDK

使用官方 Python MCP SDK：

```text
mcp
```

生产 transport：

```text
Streamable HTTP
```

公开地址：

```text
https://<domain>/mcp
```

不提供旧 REST Actions transport。

### 6.2 MCP Server instructions

初始化时提供简短 server instructions，只描述跨工具的稳定规则，例如：

- 未知目录先 inspect/search；
- 读取已知文件用 read；
- 修改使用 write/patch；
- 长命令使用 `workspaceCommand` operation 流程；
- `start/get` 已直接返回日志；
- `logs` 只用于补读、重读和大日志分页。

不要在 server instructions 重复整份 Skill 指令。

## 7. MCP Tool 设计

MCP 对外保留 7 个 Workspace tools：

```text
prepareWorkspace
workspaceInspect
workspaceSearch
workspaceReadFiles
workspaceWriteFile
workspaceApplyPatch
workspaceCommand
```

继续使用这些名字，是因为它们已经清晰、稳定，而且外部 Skill/提示词可能已经围绕这些语义编写；但不再要求兼容旧 HTTP schema。

每个 tool 使用明确 input schema 和 structured output。

### 7.1 错误模型

当前 `WorkspaceToolError` 的：

```text
code
message
suggested_next_action
```

继续保留语义，但不再转换成 FastAPI `HTTPException`。

MCP adapter 负责把它转换成模型可读的 MCP error result。

不再把 HTTP status code 当作业务契约。

### 7.2 Tool annotations

按工具真实能力声明 MCP annotations。

原则：

- inspect/search/read：read-only；
- write/patch：write tool；
- `workspaceCommand`：可以访问外部世界，也可以产生破坏性行为；
- annotations 只描述能力，不限制任意 PowerShell。

### 7.3 structuredContent

所有工具结果优先提供稳定 `structuredContent`，同时提供简短模型可读 `content`。

不要把大型文件、patch、stdout/stderr 再复制一份到 verbose 文本说明里。

## 8. `workspaceCommand` 的远程 MCP 版本

## 8.1 保留 operation 模型

仍然保留一个统一工具：

```text
workspaceCommand(
  action = start | get | logs | cancel | list,
  ...
)
```

不拆成五个 MCP tools。

原因是这五个 action 都围绕同一个 command operation resource，属于一套完整状态机，不是五个无关功能。

核心设计继续保持：

```text
MCP tool call 生命周期 != PowerShell 生命周期
```

不能把最长可运行几十分钟甚至更久的 PowerShell 直接绑定在一个远程 MCP HTTP 请求上。

### 8.2 新的正常调用链

旧逻辑：

```text
start
get
logs
get
logs
get
logs
```

远程 MCP 改成：

```text
start
  -> operation + 当前 stdout/stderr + next offsets

get
  -> 状态 + bounded wait + 增量 stdout/stderr + next offsets

get
  -> 状态 + bounded wait + 增量 stdout/stderr + next offsets

...

terminal state
```

`logs` 不再是正常 follow 流程中的必经步骤。

### 8.3 `start`

`start` 输入继续包含：

```text
idempotency_key
workspace_id
script
timeout_seconds
max_output_bytes
plain_output
utf8_output
max_bytes
```

行为：

1. 创建 operation；
2. 独立启动 PowerShell；
3. 在短同步窗口内等待快速命令完成；
4. 无论命令是否已结束，都读取当前已有 stdout/stderr；
5. 返回 operation 状态和日志游标。

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

因此长命令第一次 `start` 返回 `running` 时，模型也能马上看到已经产生的首批日志。

### 8.4 `get`

`get` 输入：

```text
operation_id
wait_seconds
stdout_offset
stderr_offset
max_bytes
```

`wait_seconds` 使用较短 bounded wait，不等同于 command timeout。

建议默认值继续从现有 5 秒同步窗口思路出发，并允许配置一个小上限。

`get` 等待以下任一条件：

1. operation 进入 terminal state；
2. stdout 从给定 offset 后产生新数据；
3. stderr 从给定 offset 后产生新数据；
4. `wait_seconds` 到期。

然后一次返回：

```text
operation
stdout
stderr
next_stdout_offset
next_stderr_offset
stdout_eof
stderr_eof
```

正常情况下模型只需要连续调用 `get`，不用额外再调用 `logs`。

### 8.5 `get` 内部实现

当前 `wait_for_terminal()` 只等待 task 结束，不感知新日志。

需要新增一个类似：

```text
wait_for_change(operation_id, stdout_offset, stderr_offset, wait_seconds)
```

的内部能力。

它监听/检查：

- operation 是否完成；
- stdout 从 `stdout_offset` 后是否已经出现至少一个完整可解码 UTF-8 code point；
- stderr 从 `stderr_offset` 后是否已经出现至少一个完整可解码 UTF-8 code point。

运行中的 command 遇到临时 EOF 时，不能把 incomplete UTF-8 sequence 当成真正 EOF：

- partial bytes 不输出 replacement character；
- partial bytes 不推进 offset；
- `wait_for_change` 在 bounded wait 内继续等剩余 byte；
- operation 进入 terminal state 后，才允许 final decoder 处理真正残留的不完整尾巴。

不需要把 PowerShell stdout/stderr 改成 MCP streaming channel；现有文件日志模型继续保留。

实现可以使用小间隔异步轮询或内部 event，但必须 bounded，并且不能阻塞 event loop。

### 8.6 `logs`

`logs` 继续保留，但定位变成显式日志工具：

- 从任意 offset 补读；
- 重新读历史日志；
- 大日志手工分页；
- 之前返回被 `max_bytes` 截断后继续读取。

输入继续使用：

```text
operation_id
stdout_offset
stderr_offset
max_bytes
```

### 8.7 `cancel`

继续取消 operation，并终止对应 PowerShell process tree。

不改变现有 process-tree cleanup 设计。

### 8.8 `list`

继续列出 operation，并允许按 state 过滤。

它用于人工诊断和恢复上下文，不承担正常日志 follow。

### 8.9 idempotency

`start` 的 idempotency 保留。

远程 MCP 同样可能发生：

```text
命令已经启动
-> 网络响应丢失
-> 客户端重试 tool call
```

因此 `idempotency_key + request_hash -> existing operation_id` 仍然有价值，特别是命令可能执行：

- `git push`；
- `gh pr create`；
- `gh workflow run`；
- 文件删除或其他有副作用的命令。

## 9. OAuth 2.1

## 9.1 本项目不提供 noauth 模式

OpenAI 的 MCP 体系允许匿名 MCP，但本项目拥有私有 Workspace、文件写入和任意 PowerShell，因此正式 ChatGPT Web 链路强制 OAuth。

删除：

```text
SKILL_TEMPLE_BEARER_TOKEN
```

不再提供自定义 API Key/Bearer Token 兼容入口。

## 9.2 OAuth 架构

```text
ChatGPT Web
    |
    | Authorization Code + PKCE S256
    v
Authorization Server
    |
    | Access Token
    v
Remote MCP Resource Server
```

MCP Server 每次请求验证 Access Token。

### 9.3 必须实现的协议要求

至少包括：

- Protected Resource Metadata；
- `/.well-known/oauth-protected-resource` 或标准 discovery challenge；
- Authorization Server Metadata；
- Authorization Code flow；
- PKCE `S256`；
- `resource` 参数贯穿授权和 token exchange；
- token signature 校验；
- issuer 校验；
- audience/resource 校验；
- expiry/nbf 校验；
- scope 校验；
- 整个 `/mcp` 在 initialize 前强制 OAuth；
- 未授权时 HTTP 401 `WWW-Authenticate` challenge；
- scope 不足时 HTTP 403 `insufficient_scope` challenge；
- 使用 ChatGPT MCP 管理页给出的正确 redirect URI。

本项目不采用“匿名 MCP 连接成功后，某个 tool 再通过 `_meta["mcp/www_authenticate"]` 触发登录”的工具级混合认证模式。7 个 Workspace tools 全部继承同一个 server-level OAuth 边界。

即使整个 server 都要求 OAuth，`tools/list` 仍然为每个 tool 显式输出顶层 `securitySchemes`，并镜像到 `_meta.securitySchemes`。当前 Python MCP SDK 2.2 的核心 `Tool` 类型还没有建模 OpenAI 的顶层字段，因此实现通过 SDK 的 server middleware 在核心协议校验完成后补充该 descriptor 字段；不是字符串改写，也不修改 SDK 包。

`MCP_PUBLIC_URL` 同时作为唯一 canonical MCP resource 和 Access Token audience。OAuth Provider 必须为这个 resource 签发 Token，不提供独立 `OAUTH_AUDIENCE` 兼容配置。

### 9.4 OAuth client 注册方式

按当前 OpenAI 支持方式选择其中一种：

- CIMD；
- DCR；
- 预定义 OAuth client。

实现时优先使用成熟 OAuth/OIDC Provider，不自己造完整认证系统。

Provider 必须真正满足 MCP 的 metadata、PKCE、resource/audience 和 ChatGPT client registration 要求。

### 9.5 单用户授权

虽然使用 OAuth，但只允许自己的账号通过授权。

第一版 scope 可以保持简单：

```text
workspace:execute
```

全部 7 个 tools 都要求这个 scope。

这里不为了形式拆成复杂 scope 模型。

## 10. 配置重构

现有 `.env.example` 中与 Actions/Skill 有关的变量全部删除：

```text
SKILL_TEMPLE_SERVER_URL
SKILL_TEMPLE_SKILLS_DIR
SKILL_TEMPLE_OPENAPI_OUTPUT
SKILL_TEMPLE_BEARER_TOKEN
```

新的配置集中到 `config.py`，例如：

```text
WORKSPACE_ROOT
WORKSPACE_OPERATION_ROOT
WORKSPACE_COMMAND_SYNC_WAIT_SECONDS
WORKSPACE_COMMAND_TIMEOUT_SECONDS
WORKSPACE_COMMAND_MAX_OUTPUT_BYTES

MCP_PUBLIC_URL
OAUTH_ISSUER
OAUTH_JWKS_URL
OAUTH_ALLOWED_SUBJECT
MCP_REQUIRED_SCOPE
```

OAuth Provider 特定配置按最终选型补充。

正式 Remote MCP 配置中 `OAUTH_ISSUER` 和 `OAUTH_JWKS_URL` 都必须使用绝对 HTTPS URL，不提供 HTTP OAuth 基础设施兼容模式。

`.env` 解析函数从旧 `runtime.py` 抽出来，不让 Workspace 模块继续依赖 Skill runtime。

## 11. `pyproject.toml` 重构

### 删除

- GPT Actions / OpenAPI 相关描述；
- `PyYAML`，如果删除 Skill runtime 后不再有其他用途；
- `skill-temple-eval`；
- `skill-temple-build-prompt`；
- `skill-temple-build-openapi`；
- 旧 `skill-temple` CLI。

### 新增/调整

- 项目名改为 `workspace-mcp`；
- 增加官方 `mcp` SDK；
- 保留 Pydantic；
- 按 MCP SDK 实际运行方式保留或调整 Uvicorn/HTTP 依赖；
- 增加 OAuth token verification 所需依赖；
- 新 CLI：

```text
workspace-mcp
```

## 12. 测试体系重构

### 12.1 删除 legacy tests

删除只验证以下内容的测试：

- SkillRuntime；
- prompt builder；
- OpenAPI builder；
- Bearer Action auth；
- `/console`；
- `/v1/action-logs`；
- Skill eval；
- GPT Actions route schema。

因此 `tests/test_runtime.py` 不再原样保留。

### 12.2 保留 Workspace 回归测试

保留并适配：

- registry；
- read/search/inspect；
- write；
- patch；
- command operation；
- timeout；
- cancel；
- idempotency；
- log offsets；
- UTF-8 多字节字符跨分页边界时不损坏；
- running command 将一个 UTF-8 code point 分多次写入 pipe 时，`start -> get` 不提前消费 partial bytes；
- 文件工具拒绝 `..`、绝对路径和指向 root 外的 symlink/junction；
- `workspaceCommand` 仍可按设计访问 Workspace root 外的 OS-account-scoped 路径；
- output truncation。

模块 rename 后更新 import，不为了新 transport 重写已经可靠的内核测试。

### 12.3 新增 MCP contract tests

新增：

```text
tests/test_mcp_tools.py
tests/test_mcp_auth.py
```

至少验证：

- MCP initialize；
- 7 个 tools 可发现；
- tool input schema；
- tool descriptor 顶层 `securitySchemes` 与 `_meta.securitySchemes`；
- structured output；
- 大型 structured output 不在文本 `content` 中完整复制；
- tool schema 暴露与实际参数校验一致的长度、范围和 pattern；
- paths/queries 数组 item 约束与单值 path/query 约束一致；
- `overwrite_if_sha256_matches` 在 schema 中条件要求 `expected_sha256`；
- `workspaceCommand` 的 timeout/output maximum 从当前运行时配置写入 descriptor；
- WorkspaceToolError -> MCP error result；
- OAuth 必须存在；
- invalid token；
- expired token；
- wrong issuer；
- wrong audience/resource；
- missing scope；
- valid token；
- OAuth challenge metadata。

### 12.4 `workspaceCommand` 新行为测试

必须覆盖：

#### start

- 快速成功：直接返回 terminal + 全部当前日志；
- 快速失败：直接返回 terminal + stderr；
- 慢命令：返回 `running` + 首批日志；
- 返回正确 next offsets；
- idempotent retry 返回原 operation。

#### get

- 有新 stdout 时提前返回；
- 有新 stderr 时提前返回；
- terminal 时提前返回；
- 无变化时 `wait_seconds` 到期返回 running；
- 连续 get 使用 next offsets 不重复日志；
- `max_bytes` 截断后可以继续 get；
- stdout/stderr 游标独立。

#### logs

- 任意 offset 补读；
- terminal 后重新读取；
- 大日志分页。

#### cancel/list

- cancel 终止进程树；
- list/state filter 正常。

## 13. README 全量重写

README 不再以 Skill Temple / Custom GPT Actions 为主语。

新 README 只描述：

1. 这个项目是什么：个人 Remote Workspace MCP Server；
2. 架构；
3. 7 个 MCP tools；
4. `workspaceCommand` 生命周期；
5. 任意 PowerShell 权限模型；
6. OAuth 配置；
7. 安装依赖；
8. `gh auth`；
9. 启动 MCP Server；
10. MCP Inspector 验证；
11. ChatGPT Developer Mode 添加 `/mcp`；
12. 测试和 lint。

README 中全部删除：

- Custom GPT Actions；
- GPT Instructions；
- OpenAPI schema；
- `loadSkills`；
- `readSkillContent`；
- Skill catalog；
- Tampermonkey；
- Action 小窗；
- Actions Bearer Token；
- OpenAPI generator；
- Skill eval。

## 14. 实施顺序

这是一次破坏式更新，不设计双轨切换。

### 阶段 1：清理项目边界

1. 新建 `workspace_mcp` 包；
2. 抽出 `config.py`；
3. 抽出通用 logging/redaction；
4. 搬迁 Workspace 内核；
5. 修复内核 import；
6. 保证 Workspace 内核测试通过。

### 阶段 2：实现 MCP tools

1. 加入官方 `mcp` SDK；
2. 创建 Remote MCP Server；
3. 注册 7 个 tools；
4. 直接调用 Workspace service；
5. 实现 structured results / errors / annotations；
6. 实现 `workspaceCommand` 新 `start/get` 日志语义。

### 阶段 3：实现 OAuth

1. 选定 OAuth/OIDC Provider；
2. 配置单用户访问；
3. Protected Resource Metadata；
4. Authorization Server discovery；
5. PKCE S256；
6. `MCP_PUBLIC_URL` 作为唯一 canonical resource / audience；
7. token validation；
8. `/mcp` 全局 OAuth 401 challenge；
9. required scope 的 403 challenge；
10. 固定 `sub`，限制为个人账号。

### 阶段 4：删除全部 legacy

直接删除：

- GPT Actions routes；
- OpenAPI builder；
- Prompt builder；
- Skill runtime；
- Skill eval；
- example skills；
- userscript；
- userscript workflow；
- Action monitor event buffer；
- legacy CLI；
- legacy env vars；
- legacy tests。

最终仓库中不留下“备用旧版本”。

### 阶段 5：文档和端到端验证

1. 全量重写 README；
2. 更新 `.env.example`；
3. MCP Inspector 验证；
4. OAuth 实际授权验证；
5. ChatGPT Web Developer Mode 添加 Remote MCP；
6. 跑真实 Workspace 工作流。

## 15. 端到端验收

最终必须从真实 ChatGPT Web 完成：

1. OAuth 授权；
2. `prepareWorkspace`；
3. `workspaceInspect`；
4. clone GitHub repo；
5. `workspaceSearch`；
6. `workspaceReadFiles`；
7. `workspaceWriteFile`；
8. `workspaceApplyPatch`；
9. `workspaceCommand(start)` 执行快速命令；
10. `workspaceCommand(start)` 执行长命令并拿到首批日志；
11. 连续 `workspaceCommand(get)` 获取状态和增量日志；
12. 验证日志不重复；
13. 用 `logs` 从指定 offset 补读；
14. `cancel` 取消长任务；
15. 通过 PowerShell 使用 `git`；
16. 通过 PowerShell 使用 `gh`；
17. 运行项目测试/构建；
18. 后续调用继续复用已有 Workspace。

验收完成时，不应再依赖：

```text
Custom GPT
GPT Actions
OpenAPI Actions schema
loadSkills/readSkillContent
Tampermonkey
/v1/action-logs
SKILL_TEMPLE_BEARER_TOKEN
```

## 16. 本地验证

代码改造过程中至少持续运行：

```powershell
python -m pytest -q
python -m ruff check .
```

MCP 实现完成后增加：

```text
MCP Inspector
ChatGPT Web Developer Mode
```

两层真实验证。

## 17. 完成定义

这个重构只有同时满足以下条件才算完成：

- Remote MCP 是唯一业务入口；
- OAuth 是唯一 ChatGPT-facing 认证方式；
- 7 个 Workspace tools 全部通过 MCP 暴露；
- 任意 PowerShell 保留；
- `workspaceCommand` 的 PowerShell 生命周期独立于 tool call；
- `start/get` 直接返回增量日志；
- `logs` 只负责显式补读/分页；
- Workspace 内核回归测试通过；
- MCP/OAuth contract tests 通过；
- 真实 ChatGPT Web 端到端通过；
- GPT Actions/OpenAPI/Skill runtime/userscript 代码已删除；
- README 和配置中不再出现旧运行方式。

## 18. 官方参考

- Custom GPT retirement and migration FAQ
  https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq

- Build an MCP server
  https://developers.openai.com/plugins/build/mcp-server

- Authentication
  https://developers.openai.com/plugins/build/auth

- Connect and test your plugin
  https://developers.openai.com/plugins/deploy/connect-chatgpt
