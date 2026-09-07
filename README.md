# Skill Temple

Skill Temple 把 Codex 的 Skill 思路适配到 Custom GPT Actions：

1. 构建时把每个 Skill 的 `name + description + skill_id` 编译进 GPT Instructions。
2. 模型在初始上下文中看到 Skill 目录，自行选择需要的 Skill。
3. 选中后调用 `loadSkills`，只加载对应的完整 `SKILL.md`。
4. `SKILL.md` 引用的其他文件再通过 `readSkillContent` 按需读取。
5. 实际项目读取、修改和命令执行由 Workspace Actions 完成。

不会把所有 Skill 正文静态塞进 prompt，也不需要先调用 Action 查询目录。

第一次部署请先完成下文的 [安装和运行](#安装和运行)，再生成 GPT Instructions 和 `openapi.json`。

## 公开 Actions

| operationId | 路径 | 用途 |
| --- | --- | --- |
| `loadSkills` | `POST /v1/skills/load` | 按精确 `skill_id` 加载完整 `SKILL.md` |
| `readSkillContent` | `POST /v1/skills/read` | 读取选中 Skill 内的引用文件 |
| `prepareWorkspace` | `POST /v1/workspace/prepare` | 创建或复用持久 workspace |
| `workspaceInspect` | `POST /v1/workspace/inspect` | 查看目录、搜索结果和文件片段 |
| `workspaceSearch` | `POST /v1/workspace/search` | 使用 ripgrep 搜索工作区 |
| `workspaceReadFiles` | `POST /v1/workspace/read-files` | 读取工作区文件 |
| `workspaceWriteFile` | `POST /v1/workspace/write-file` | 创建或覆盖文本文件 |
| `workspaceApplyPatch` | `POST /v1/workspace/apply-patch` | 应用多文件文本补丁 |
| `workspaceCommand` | `POST /v1/workspace/command` | 异步运行 PowerShell 7 命令 |

## Workspace 模型

`WORKSPACE_ROOT` 是持久 workspace 的容器目录，而不是单个项目目录。`prepareWorkspace` 根据 `idempotency_key` 创建稳定的 `ws_*` 目录；再次使用同一个 key 会复用原目录，也可以直接传已有 `workspace_id` 继续工作。

Workspace 本身不理解 GitHub、repo、branch、PR 或 CI，也不会 clone 仓库。模型在 workspace 中直接通过 `workspaceCommand` 使用 `git`、`gh`、Python、构建工具或其他宿主 CLI：

```powershell
gh repo clone qqq694637644/project .
git switch main
git fetch origin
git switch feature/example
gh pr view 123
```

同一个 workspace 可以长期复用并自由切换 branch，也可以同时放多个仓库。不同任务需要隔离状态时创建不同的 workspace。

除 `workspaceCommand(action="start")` 外，文件类 Workspace Actions 都要求显式 `workspace_id`；命令启动后，`get`、`logs`、`cancel` 使用全局唯一 `operation_id` 即可。operation 的 timeout、日志、取消、进程树终止、持久状态和 idempotency 机制保持独立于 workspace 生命周期。

`workspaceCommand` 是宿主权限下的原生 PowerShell：后端不检查命令字符串、不区分网络命令，也不清洗子进程环境。实际权限边界就是运行服务的操作系统账户以及该账户已经配置的 CLI/凭据。

## Skill 目录

```text
skills/
  api-review/
    SKILL.md
    docs/
      openapi.md
    scripts/
      helper.py
```

`SKILL.md` 必须包含 frontmatter：

```markdown
---
name: api-review
description: Review API schemas, compatibility, and migration risks.
---

# API review

Read `docs/openapi.md` when the task involves OpenAPI compatibility.
```

`name` 同时作为稳定的 `skill_id`。详细资料放在 `docs/`、`references/`、`scripts/` 或 `assets/`，并从 `SKILL.md` 中明确引用。

## 生成 GPT Instructions

`GPT_ACTION_PROMPT.md` 是模板，其中包含：

```text
{{SKILL_CATALOG}}
```

安装后运行：

```powershell
skill-temple-build-prompt --skills-dir C:/path/to/skills
```

默认输出：

```text
dist/GPT_INSTRUCTIONS.md
```

生成器会把当前所有 Skill 的元数据替换进模板：

```text
- api-review: Review API schemas, compatibility, and migration risks. (skill_id: api-review)
- release-notes: Draft release notes from repository changes. (skill_id: release-notes)
```

把生成文件复制到 Custom GPT 的 Instructions。Skill 增删或 description 修改后重新生成即可。

也可以指定输入输出：

```powershell
skill-temple-build-prompt `
  --skills-dir C:/path/to/skills `
  --template GPT_ACTION_PROMPT.md `
  --output dist/GPT_INSTRUCTIONS.md
```

## 生成 `openapi.json`

安装后运行：

```powershell
skill-temple-build-openapi
```

默认输出根目录的 `openapi.json`。生成器优先读取 `.env` 中的：

```dotenv
SKILL_TEMPLE_SERVER_URL=https://skills.example.com
SKILL_TEMPLE_OPENAPI_OUTPUT=openapi.json
```

因此生成结果会包含：

```json
{
  "servers": [
    {"url": "https://skills.example.com"}
  ]
}
```

也可以直接覆盖：

```powershell
skill-temple-build-openapi `
  --server-url https://skills.example.com `
  --output openapi.json
```

## `loadSkills`

请求：

```json
{
  "skill_ids": ["api-review"]
}
```

响应中的 `skills[].content` 使用 Codex 风格的上下文块：

```xml
<skill>
<name>api-review</name>
<path>api-review/SKILL.md</path>
完整 SKILL.md 内容
</skill>
```

一次可以加载多个 Skill。运行时只做精确 ID 加载，不替模型判断哪个 Skill 匹配任务。

## `readSkillContent`

```json
{
  "skill_id": "api-review",
  "path": "docs/openapi.md",
  "start_line": 1,
  "max_lines": 300
}
```

相对路径被限制在对应 Skill 目录内。响应包含 `truncated` 和 `next_start_line`，大型引用文件可以继续读取。

## 配置

复制 `.env.example` 为 `.env`：

```dotenv
SKILL_TEMPLE_SERVER_URL=https://skills.example.com
WORKSPACE_ROOT=C:/path/to/persistent/workspaces

# Optional: enable Bearer authentication for /v1/* endpoints.
# SKILL_TEMPLE_BEARER_TOKEN=replace-with-a-long-random-secret
```

其他环境变量只在需要覆盖默认行为时设置。例如自定义 Skill 目录、OpenAPI 输出路径、PowerShell 路径、operation 存储目录，以及 command timeout/output limits；未设置时使用程序内默认值。

Skill 目录查找顺序：

1. 命令行或 `create_app(skills_dir=...)`
2. `SKILL_TEMPLE_SKILLS_DIR`
3. 当前目录 `.env`
4. 当前目录的 `skills/`
5. 包内示例 Skill

设置 `SKILL_TEMPLE_BEARER_TOKEN` 后，所有 `/v1/*` 接口以及控制台的加载、读取请求都要求：

```text
Authorization: Bearer <token>
```

`/openapi.json`、`/health` 和 `/console` 保持公开，方便导入 schema 和打开调试页面。生成的 OpenAPI 会自动包含 `BearerAuth` security scheme。

## 安装和运行

### 1. 前置条件

- Python 3.11 或更高版本。
- PowerShell 7，命令名必须是 `pwsh`；`workspaceCommand` 使用它执行命令。
- ripgrep，命令名必须是 `rg`；`workspaceSearch` 和 `workspaceInspect` 使用它搜索文件。
- 如果要使用内置 `github-maintenance` Skill，再安装 Git 和 GitHub CLI (`gh`) 并完成 GitHub 登录。

先确认宿主工具已经在 `PATH`：

```powershell
python --version
pwsh --version
rg --version
git --version
gh --version
```

只使用非 GitHub Workspace 功能时，`git` 和 `gh` 不是必需项。

### 2. 克隆项目并创建虚拟环境

```powershell
git clone https://github.com/qqq694637644/github_skills_action.git
Set-Location github_skills_action

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

如果 `python` 不是目标 Python 3.11+，Windows 也可以用 `py` launcher 显式选择版本，例如：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 3. 安装项目

仅运行服务：

```powershell
python -m pip install -e .
```

需要运行测试和 Ruff 的开发环境：

```powershell
python -m pip install -e ".[dev]"
```

安装成功后应能直接找到这些入口：

```powershell
skill-temple --help
skill-temple-build-prompt --help
skill-temple-build-openapi --help
```

### 4. 配置 `.env`

从示例创建本地配置：

```powershell
Copy-Item .env.example .env
```

至少确认：

```dotenv
SKILL_TEMPLE_SERVER_URL=https://skills.example.com
WORKSPACE_ROOT=C:/path/to/persistent/workspaces
```

`WORKSPACE_ROOT` 是所有持久 workspace 的父目录；目录不存在时服务会自动创建。`SKILL_TEMPLE_SERVER_URL` 应填写最终提供给 Custom GPT Actions 访问的 HTTPS 地址，而不是本机监听地址。

如果需要 Bearer 认证，再在 `.env` 中启用：

```dotenv
SKILL_TEMPLE_BEARER_TOKEN=replace-with-a-long-random-secret
```

不要提交包含真实 token 的 `.env`。

### 5. 可选：配置 GitHub CLI

使用 `github-maintenance` Skill 前确认 `gh` 已登录，并让 Git HTTPS 操作使用相同认证：

```powershell
gh auth status
gh auth setup-git
gh api user --jq .login
```

如果尚未登录，可先运行：

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

服务启动后，`workspaceCommand` 会继承运行服务账户的环境和 CLI 登录状态，因此应当用**实际运行 `skill-temple` 的同一个操作系统账户**完成 `gh` 登录。

### 6. 启动服务

仅供本机验证时：

```powershell
skill-temple --host 127.0.0.1 --port 8765
```

如果需要让反向代理、容器网络或其他主机访问，可以监听所有网卡：

```powershell
skill-temple --host 0.0.0.0 --port 8765
```

`--host` 只控制本地监听地址；Custom GPT Actions 使用的公网地址仍由 `SKILL_TEMPLE_SERVER_URL` / `--server-url` 决定，并应通过 HTTPS 暴露。

### 7. 验证安装

启动服务后检查：

健康检查：

```text
http://127.0.0.1:8765/health
```

OpenAPI schema：

```text
http://127.0.0.1:8765/openapi.json
```

调试检索控制台：

```text
http://127.0.0.1:8765/console
```

控制台可以查看 Skill 目录、调用 `loadSkills`，以及读取选中 Skill 内的引用文件。Token 只保存在当前浏览器标签页的 `sessionStorage`。

## Skill 检索评测

评测工具验证编译目录、精确加载、引用路径和关键符号是否可达：

```powershell
skill-temple-eval evals/skill_queries.jsonl
```

JSONL 示例：

```json
{"id":"api-review","query":"review API compatibility","expected_skill":"api-review","expected_paths":["docs/openapi.md"],"expected_symbols":["breaking change"]}
```

当前架构由模型根据静态目录选择 Skill，因此该工具不模拟服务端语义路由，只检查被选 Skill 的加载链路和引用资料是否完整。

## 验证

```powershell
python -m ruff check .
python -m pytest -q
skill-temple-eval evals/skill_queries.jsonl
skill-temple-build-openapi --output .runtime/openapi.json
```

测试覆盖：Skill 扫描、目录生成、精确加载、Codex 风格上下文、引用路径发现、安全读取、Bearer Token、调试控制台、评测工具、OpenAPI 生成和 Workspace Actions。
