# ChatGPT 网页版 MCP 迁移计划

## 目标

把当前基于 Custom GPT Actions 的接入方式迁移到 ChatGPT 网页版远程 MCP，同时尽量保持现有后端行为不变。

这次迁移的重点是：

- 更换 ChatGPT 与后端之间的接入协议；
- 增加符合网页版 MCP 要求的 OAuth 认证；
- 保留已经稳定使用的 Workspace 执行模型；
- 不为了迁移去重构已经用顺手的任意 PowerShell 和长任务状态机。

这不是一次 Workspace 架构重写。

## 本次不做的事情

- 不把 `github-maintenance` 注册或重构成 ChatGPT 网页版原生 Skill。
- 不把任意 PowerShell 改成一堆狭窄的专用命令工具。
- 不拆分 `workspaceCommand(action=start|get|logs|cancel|list)`。
- 不引入多用户、多租户、每用户独立 Workspace。
- 不引入每用户独立 GitHub 凭据。
- 除非 MCP 兼容性确实要求，否则不重构 Workspace 内核。

## 必须保持兼容的现有行为

以下行为都视为迁移后的兼容性要求。

### 1. 保留单用户、单环境模型

继续维持：

- 一个持久化 Workspace 根目录；
- 一个后端服务 OS 账户；
- 一套现有的 `git` / `gh` 凭据；
- 一套 Python、构建工具、网络 CLI 和项目工具环境。

这是个人使用场景，不因为接入 OAuth 就强行改成多租户系统。

### 2. 保留任意 PowerShell

`workspaceCommand` 继续允许直接执行任意 PowerShell。

例如现有能力继续保留：

- `git`；
- `gh`；
- Python；
- 测试、构建、lint；
- 项目 CLI；
- 网络 CLI；
- 多条命令组合；
- 其他 PowerShell 能执行的操作。

不增加命令白名单，不增加命令解析器。

实际命令权限仍然由后端服务所在 OS 账户决定。

### 3. 保留 `workspaceCommand` 单工具状态机

继续保留当前工具形式：

```text
workspaceCommand(
  action = start | get | logs | cancel | list,
  ...
)
```

长任务继续按当前方式工作：

```text
start -> operation_id -> get/logs -> terminal state
```

需要继续保留：

- `start` 启动命令；
- 短命令直接返回终态；
- 长命令返回 `operation_id`；
- `get` 查询状态；
- `logs` 分页读取 stdout/stderr；
- `cancel` 取消运行中的命令；
- `list` 查看操作列表；
- timeout；
- operation 持久化；
- stdout/stderr continuation offset；
- truncation 标记；
- 现有 idempotency 行为。

这里不做拆工具重构。

## ChatGPT 网页版 MCP 对本项目有影响的要求

目标接入方式需要遵循当前 ChatGPT Plugin / Remote MCP 的要求，而不是继续沿用 Custom GPT Actions 的认证模型。

## MCP 传输方式

使用远程 MCP 的 Streamable HTTP 方式，对外提供稳定 HTTPS 地址。

建议入口：

```text
https://<domain>/mcp
```

本地开发时可以使用 Secure MCP Tunnel 或等价方式临时暴露服务。

生产使用时应提供稳定远程 HTTPS MCP 地址。

## OAuth 认证

ChatGPT 可以连接匿名 `noauth` MCP，但本项目不应该使用匿名方式。

原因很直接：当前 MCP 后端将拥有以下能力：

- 读取私有 Workspace；
- 修改文件；
- 应用 patch；
- 执行任意 PowerShell；
- 调用 `git` / `gh`；
- 运行网络命令。

因此，本项目把 OAuth 认证作为迁移必做项。

### OAuth 方案

采用符合当前 MCP / ChatGPT 要求的 OAuth 2.1 授权流程：

```text
Authorization Code + PKCE S256
```

MCP Resource Server 至少需要支持：

- Protected Resource Metadata；
- OAuth Authorization Server Metadata；
- Authorization Code Flow；
- PKCE `S256`；
- MCP `resource` 参数；
- Access Token audience 校验；
- Access Token issuer 校验；
- Access Token expiry 校验；
- scope 校验；
- MCP 工具 `securitySchemes`；
- 未授权或权限不足时返回 ChatGPT 能识别的 OAuth challenge 信息。

### Protected Resource Metadata

MCP 服务需要暴露或正确声明类似：

```text
/.well-known/oauth-protected-resource
```

也可以通过标准 `WWW-Authenticate` discovery 方式引导 ChatGPT 找到 protected-resource metadata。

### 旧 Bearer Token 的处理

现有：

```text
SKILL_TEMPLE_BEARER_TOKEN
```

不能继续作为 ChatGPT 网页版 MCP 的主要认证方式。

它可以暂时保留给旧 Actions 接口或内部调试，但 ChatGPT Web -> MCP 这条正式链路应改成 OAuth。

## 个人使用的 OAuth 模型

这里最重要的一点是：

**OAuth 不等于必须做多租户。**

本项目仍然按单用户部署：

```text
ChatGPT 账号
    ↓
OAuth 授权
    ↓
一个 MCP 服务实例
    ↓
一个服务 OS 账户
    ↓
一个现有 Workspace 根目录
    ↓
一套现有 git / gh 登录状态
```

OAuth 的作用只是确认：

> 当前请求确实来自已经授权的 ChatGPT 客户端。

不在 Workspace 内核里引入：

```text
user_id -> workspace
user_id -> github credential
user_id -> tenant
```

这些当前都没有必要。

第一版可以只允许一个个人账号完成授权。

如果使用现成 OAuth/OIDC Provider，应选择能满足 MCP metadata、PKCE、resource/audience 等要求的方案。

如果自己实现最小 OAuth Authorization Server，也必须完整满足同样的协议要求，不能因为“只是个人用”就把 ChatGPT-facing MCP 改回固定静态 Bearer Token。

## 目标架构

```text
ChatGPT Web
    |
    | MCP Streamable HTTP + OAuth 2.1
    v
Remote MCP Endpoint (/mcp)
    |
    v
薄 MCP Adapter
    |
    v
WorkspaceActionService
    |
    v
LocalWorkspaceService
    |
    |-- WorkspaceRegistry
    |-- Workspace Files/Search/Patch
    `-- WorkspaceOperationManager
            |
            `-- 任意 PowerShell / git / gh / 项目 CLI
```

原则：

- OAuth 放在 MCP 边界；
- MCP adapter 尽量薄；
- Workspace 内核继续保持 transport-independent；
- 不把 OAuth 用户概念强行下沉到现有 Workspace 服务。

## 仓库改造范围

## 新增

建议新增：

```text
src/skill_temple/mcp_server.py
```

或等价 MCP 入口文件。

同时新增：

- MCP SDK 依赖；
- Streamable HTTP `/mcp` 入口；
- OAuth Resource Server 集成；
- OAuth issuer / audience / scope 配置；
- protected-resource metadata；
- MCP contract tests；
- ChatGPT Web 连接说明；
- OAuth 配置说明。

## 尽量原样复用

以下模块优先保持不动，或者只做非常小的兼容修改：

```text
src/skill_temple/workspace_registry.py
src/skill_temple/workspace_files.py
src/skill_temple/workspace_patch.py
src/skill_temple/workspace_operations.py
src/skill_temple/workspace_actions.py
```

现有 Workspace 测试也继续保留。

如果当前 `workspace_actions.py` 已经承担 transport-independent facade 的作用，就继续让它承担这一层职责。

目标结构：

```text
MCP Tool
    ↓
WorkspaceActionService
    ↓
LocalWorkspaceService
```

而不是在 MCP 层重新实现一遍文件、patch、operation 逻辑。

## MCP 暴露的工具

保持当前工具集合：

- `prepareWorkspace`
- `workspaceInspect`
- `workspaceSearch`
- `workspaceReadFiles`
- `workspaceWriteFile`
- `workspaceApplyPatch`
- `workspaceCommand`

其中：

```text
workspaceCommand.action
```

继续保留：

```text
start | get | logs | cancel | list
```

只在 MCP schema 本身有硬性限制时做最小适配，不主动改参数和返回语义。

## 暂时保留旧链路

第一阶段不要一上来就删除现有 Custom GPT Actions 实现。

迁移期保持：

```text
旧 Actions -> WorkspaceActionService
新 MCP     -> WorkspaceActionService
```

也就是两个 transport 暂时共用同一个后端。

这样做有两个好处：

- MCP 有问题可以快速对比旧链路；
- 可以验证 MCP adapter 是否真正做到行为兼容。

只有网页版 MCP 全链路验证完成后，再删除旧代码。

## 最终可以退役的旧组件

MCP 跑通以后，再考虑删除或归档：

- Custom GPT Actions / OpenAPI transport；
- 只为 GPT Actions Skill loader 服务的接口；
- 页面 action-log polling 接口；
- 油猴脚本正常使用依赖；
- 油猴发布 workflow。

后端中仍有通用价值的部分继续保留，例如：

- 日志；
- secret redact；
- operation diagnostics；
- PowerShell operation state；
- timeout / cancellation；
- stdout / stderr 分页。

## 实施阶段

## 阶段 1：增加 MCP 传输层

### 工作内容

1. 增加 MCP SDK。
2. 创建 Streamable HTTP MCP Server。
3. 暴露 `/mcp`。
4. 注册现有 7 个 Workspace 工具。
5. 每个工具直接调用现有 `WorkspaceActionService` / `LocalWorkspaceService`。
6. 尽量保留现有：
   - 参数校验；
   - 返回字段；
   - error code；
   - truncation；
   - continuation offset；
   - operation state。
7. 旧 Actions transport 暂时继续运行。

### 验收标准

使用 MCP Inspector 可以：

- 正确发现全部 7 个工具；
- 正确读取工具 schema；
- 调用工具；
- 实际进入现有 Workspace 后端；
- 不需要为 MCP 重新实现 Workspace 逻辑。

## 阶段 2：实现 ChatGPT Web OAuth

### 工作内容

1. 确定 OAuth/OIDC Provider 或最小 Authorization Server 方案。
2. 只允许个人账号完成授权。
3. 提供 MCP Protected Resource Metadata。
4. 提供或正确引用 Authorization Server Metadata。
5. 实现 Authorization Code + PKCE `S256`。
6. 正确处理 MCP `resource` 参数。
7. Token 中 audience 必须匹配当前 MCP resource。
8. MCP Server 校验：
   - issuer；
   - audience；
   - expiry；
   - scope。
9. 所有 Workspace MCP tools 声明 OAuth `securitySchemes`。
10. 无 Token、Token 无效或 scope 不足时，返回 ChatGPT 能识别的 OAuth challenge。

### Scope

个人使用第一版不需要复杂 scope 系统。

可以先使用一个完整 Workspace 权限：

```text
workspace:execute
```

这个 scope 直接覆盖整个 Workspace MCP 能力即可。

以后如果真有需要，再拆：

```text
workspace:read
workspace:write
workspace:execute
```

当前没有必要为了形式增加复杂度。

### 验收标准

在 ChatGPT Web 中：

1. 添加 MCP；
2. 正确触发 OAuth 登录/授权；
3. 完成账号授权；
4. ChatGPT 获得有效 Access Token；
5. MCP 服务正确验证 Token；
6. 授权后能够调用 Workspace tools；
7. 未授权的直接请求无法执行 Workspace tools。

## 阶段 3：MCP 行为兼容测试

新增 MCP 层测试，重点验证 adapter 和 auth，不重复现有 Workspace 单元测试。

需要覆盖：

### Tool discovery

- 7 个工具全部存在；
- schema 正确；
- `workspaceCommand.action` 包含：
  - `start`
  - `get`
  - `logs`
  - `cancel`
  - `list`

### OAuth

- 没有 Token；
- 无效 Token；
- 过期 Token；
- issuer 错误；
- audience 错误；
- scope 不足；
- 正常 Token。

### Workspace

- `prepareWorkspace` 创建；
- `prepareWorkspace` 复用；
- inspect；
- search；
- read；
- write；
- patch；
- dry-run；
- sha256 mismatch。

### workspaceCommand

覆盖：

```text
start
start -> immediate terminal state
start -> operation_id
get
logs
cancel
list
```

还要覆盖：

- command failure；
- timeout；
- stdout 分页；
- stderr 分页；
- continuation offset；
- truncation；
- 不存在的 workspace_id；
- 不存在的 operation_id。

### 验收标准

现有测试继续通过，并且新增 MCP/OAuth contract tests 全部通过。

## 阶段 4：ChatGPT 网页版真实端到端验证

不能只停留在 MCP Inspector。

必须使用真正的 ChatGPT Web MCP 连接跑一遍实际工作流。

至少验证：

1. 创建或复用 Workspace。
2. 用 `workspaceCommand` clone / inspect 仓库。
3. 搜索代码。
4. 读取文件。
5. 修改文件。
6. 应用 patch。
7. 运行测试。
8. 运行构建。
9. 通过任意 PowerShell 调用 `git`。
10. 通过任意 PowerShell 调用 `gh`。
11. 启动一个长任务。
12. 用 `get` 查询任务状态。
13. 用 `logs` 分页读取输出。
14. 用 `cancel` 取消运行中的任务。
15. 在后续调用中继续复用现有 Workspace 状态。

### 验收标准

达到当前 GPT Actions 实际使用体验：

```text
ChatGPT Web
    -> MCP
    -> Workspace
    -> 任意 PowerShell / git / gh
```

并且正常使用时不再依赖油猴脚本。

## 阶段 5：清理旧 GPT Actions / 油猴路径

只有阶段 4 验证通过后再做。

### 工作内容

1. 把 MCP 改成 README 中推荐的主接入方式。
2. 删除或归档无调用方的 Custom GPT Actions/OpenAPI transport。
3. 删除或归档旧 Skill loader 相关接口。
4. 删除正常使用流程中的油猴依赖。
5. 如果油猴不再用于调试，则删除对应发布 workflow。
6. 保留有独立价值的后端日志、redact、operation diagnostics。
7. 再跑一次完整测试和 lint。

## 验证命令

每个实现阶段先跑直接相关测试，然后跑完整回归：

```powershell
python -m pytest -q
python -m ruff check .
```

MCP 层还需要用 MCP Inspector 验证。

最终必须再从 ChatGPT Web 做真实端到端测试。

## 迁移原则

整个迁移过程遵守以下原则：

1. **先保证兼容，再谈优化。**
2. **任意 PowerShell 是正式能力，不是临时逃生口。**
3. **`workspaceCommand(action=start|get|logs|cancel|list)` 是兼容性契约。**
4. **MCP adapter 尽量薄。**
5. **OAuth 只负责 ChatGPT-facing MCP 的授权，不强行改造 Workspace 内核。**
6. **继续保持单用户部署。**
7. **本次不做原生 Skill 注册。**
8. **MCP 没有实际跑通前，不删除旧 Actions 路径。**
9. **油猴在 MCP 全链路验证完成后再正式退役。**
10. **不为了“架构更漂亮”破坏现在已经稳定的 PowerShell / operation 调用方式。**

## 官方参考

当前计划依据以下 OpenAI 官方文档整理：

- MCP / Plugin 认证：
  https://developers.openai.com/plugins/build/auth
- 构建 MCP Server：
  https://developers.openai.com/plugins/build/mcp-server
- 在 ChatGPT 中连接和测试 Plugin：
  https://developers.openai.com/plugins/deploy/connect-chatgpt
- Personal Plugin Quickstart：
  https://developers.openai.com/plugins/quickstart
