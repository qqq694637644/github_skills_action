# Linux 原生 MCP 改造计划

## 1. 背景

当前分支 `docs/chatgpt-web-mcp-migration-plan` 已完成 Remote MCP、OAuth、持久 Workspace、文件工具和 `workspaceCommand` 的整体迁移，但运行时仍然以 Windows + PowerShell 7 为核心：

- `workspaceCommand` 默认执行 `pwsh`；
- command wrapper 使用 PowerShell 语法；
- 子进程生命周期依赖 Windows Job Object；
- Windows 下使用 `taskkill /T /F` 兜底终止进程树；
- README、工具描述、测试和环境变量均以 PowerShell/Windows 为主；
- 文件写入虽然支持 LF/CRLF，但 patch 路径会把已有文件统一改写成 LF；
- 文本事务写入通过临时文件替换目标文件，在 Linux 上还需要额外关注原文件 POSIX 权限位，尤其是 executable bit。

本分支的目标是先形成一份可审查的 Linux 原生改造方案。当前阶段只提交计划，不修改实现。

---

## 2. 改造目标

在保留现有 MCP 对外能力和 Workspace 语义的前提下，将底层运行环境改造为 Linux 原生实现：

1. `workspaceCommand` 使用 Bash，而不是 PowerShell；
2. 使用 POSIX session/process group 管理普通命令及其 descendants；
3. timeout、cancel、MCP shutdown 时可靠清理普通进程组；
4. 保留现有 operation、idempotency、增量日志、offset、output limit、ANSI 清理和 secret redact；
5. 文件工具保持 Linux 下正确的 LF/CRLF 行尾语义；
6. overwrite/patch 已有文件时保留重要的 POSIX 文件权限，避免意外丢失 executable bit；
7. 保留现有 MCP/OAuth/Workspace API 的主体结构；
8. 完整更新测试、README、配置和 MCP tool 描述，使其与 Linux 行为一致。

---

## 3. 本次明确不做

本次 Linux 改造暂不包含以下内容：

- 不转成 systemd service；
- 不增加 Docker / container 部署；
- 不增加 supervisor；
- 不引入 cgroup v2 作为第一版 command containment；
- 不解决 MCP Server 重启后恢复运行中 command；
- 不设计 Windows/Linux 双平台共用同一套 command runner；
- 不做多租户；
- 不改变现有 OAuth 信任模型；
- 不改变文件类工具的 workspace-root containment 边界；
- 不把 `workspaceCommand` 收紧为命令白名单。

本分支目标是一个明确的 **Linux 原生版本**，不是同时兼容 Windows 与 Linux 的跨平台版本。

---

## 4. 保留不变的核心能力

以下模块和语义原则上继续保留：

- `prepareWorkspace`
- `workspaceInspect`
- `workspaceSearch`
- `workspaceReadFiles`
- `workspaceWriteFile`
- `workspaceApplyPatch`
- `workspaceCommand`
- 持久 `ws_*` Workspace；
- SHA-256 compare-and-write；
- patch dry-run / rollback；
- command idempotency；
- command timeout；
- command cancel；
- stdout/stderr 分离日志；
- stdout/stderr offset 分页；
- bounded output；
- UTF-8；
- ANSI escape 清理；
- secret redact；
- MCP Streamable HTTP；
- OAuth/JWT 验证。

权限边界继续保持两层：

- 文件工具：只能访问对应 Workspace root；
- `workspaceCommand`：拥有运行 MCP 的 Linux OS 账户本身拥有的权限，不限制在 Workspace root。

---

## 5. 核心改造一：PowerShell Runner 改为 Bash Runner

### 5.1 当前问题

当前 `src/workspace_mcp/workspace_operations.py` 中：

- `OperationSettings.shell` 默认值为 `pwsh`；
- 启动参数使用 `-NoLogo -NoProfile -NonInteractive -Command`；
- `_build_pwsh_script()` 注入 PowerShell UTF-8 / plain-output 配置；
- ready-file handshake 使用 `Test-Path`、`Start-Sleep`、`Remove-Item`；
- 错误信息明确写成 `PowerShell exited ...`。

### 5.2 Linux 目标

默认 shell 改为：

```text
/bin/bash
```

建议环境变量从：

```text
WORKSPACE_PWSH_PATH
```

改为：

```text
WORKSPACE_SHELL_PATH=/bin/bash
```

使用通用名字，避免未来必须再次修改配置键。

启动方式建议：

```text
/bin/bash --noprofile --norc -c <script>
```

不继承用户交互式 profile，降低运行结果受用户 shell 初始化脚本影响的概率。

### 5.3 UTF-8 与 plain output

删除 PowerShell 专属 prelude。

UTF-8 通过 subprocess environment 处理，例如：

```text
PYTHONIOENCODING=utf-8
PYTHONUTF8=1
```

Linux locale 不应盲目硬编码一个目标机不存在的值。可以：

- 默认继承服务账户现有 `LANG` / `LC_ALL`；
- 文档明确部署环境应使用 UTF-8 locale；
- 如需代码主动设置，应先选择目标环境确认存在的 UTF-8 locale。

`plain_output` 继续依赖当前 Python 侧 `_AnsiCsiStripper`，不再依赖 PowerShell 的 `$PSStyle`。

---

## 6. 核心改造二：Windows Job Object 改为 POSIX Session / Process Group

### 6.1 当前 Windows 模型

当前实现包含 `WindowsJob`：

- `CreateJobObjectW`
- `SetInformationJobObject`
- `AssignProcessToJobObject`
- `TerminateJobObject`
- kill-on-close
- `taskkill /T /F`

这些都应从 Linux 分支删除。

### 6.2 Linux 进程模型

启动 Bash 时创建独立 session/process group。

优先使用 Python subprocess 提供的 POSIX 能力，例如：

```python
asyncio.create_subprocess_exec(
    shell,
    "--noprofile",
    "--norc",
    "-c",
    script,
    start_new_session=True,
    ...
)
```

而不是继续通过 `preexec_fn=os.setsid`。

正常情况下 root shell 的 PID 同时可以作为新 process group 的 PGID：

```text
MCP Server
  |
  +-- bash                PID/PGID=1000
       |
       +-- python         PGID=1000
            |
            +-- gcc      PGID=1000
            +-- linker   PGID=1000
```

operation 应记录能够用于清理的 process group 标识。

### 6.3 API 字段

当前 `WorkspaceOperationSummary` 中的：

```text
job_assigned
```

是 Windows Job Object 语义，Linux 版本不应继续伪装成有效字段。

建议改为：

```text
process_group_id
```

或删除 `job_assigned`，仅保留 `root_pid` 并在内部维护 PGID。

更推荐显式提供 `process_group_id`，便于诊断 command 生命周期问题。

---

## 7. timeout / cancel / shutdown 的 Linux 清理语义

### 7.1 普通终止流程

不建议 Linux 下直接第一步使用 SIGKILL。

标准流程：

```text
SIGTERM process group
        |
        v
等待 kill_grace_seconds
        |
        +-- 全部退出 -> 完成
        |
        '-- 仍有进程 -> SIGKILL process group
```

目的：

- 允许 git/python/build tool 做正常清理；
- 保留现有 grace period 配置的实际意义；
- 最终仍能强制结束挂死进程。

### 7.2 root shell 已退出但 descendant 仍存活

这是 Linux 版本必须专门处理的情况。

例如：

```bash
some-long-command &
exit 0
```

root Bash 可能已经退出，但同一个 process group 中的后台进程仍在运行。

因此 cleanup 不能只依赖：

```text
proc.returncode is None
```

operation 进入 terminal state 前/后，应对该 PGID 做最终清理确认。

目标是避免出现：

```text
workspaceCommand = succeeded
但该 command 留下普通后台 descendant 持续运行
```

---

## 8. process group 的已知边界：setsid / setpgid / daemonize

第一版 Linux runner 使用 process group，能够覆盖主要工作负载：

- git；
- gh；
- Python；
- pytest / Ruff；
- gcc / clang；
- make / cmake；
- npm/pnpm/yarn build/test；
- 普通项目 CLI；
- 它们正常 fork/exec 出来的 descendants。

但 POSIX process group 不是安全沙箱。

子进程如果主动执行以下行为，可以离开原 PGID：

- `setsid()`：创建新的 session，同时脱离原 process group；
- `setpgid()`：主动切换 process group；
- 传统 daemonize：通常包含 fork → setsid → fork；
- 某些 launcher/supervisor 主动重新建立 session。

例如：

```bash
setsid some-program &
```

原始 command PGID 被 kill 后，`some-program` 可能仍然存活。

### 第一版的处理原则

第一版明确接受这个边界：

- 保证普通 descendants 的清理；
- 不承诺约束主动逃离 session/process group 的程序；
- README 中明确记录；
- 测试中验证普通 descendants 一定被清理；
- 对 `setsid` 边界增加可控测试/说明，但测试本身必须自行回收创建的进程，不能在测试宿主残留进程。

如果后续确实需要“即使 setsid/daemonize 也不能逃逸”，再单独评估 cgroup v2 / systemd scope，不放进本轮改造。

---

## 9. ready-file handshake 的处理

当前 ready-file 主要用于 Windows：

```text
创建 PowerShell
-> 将 PowerShell attach 到 Windows Job Object
-> 写 job.ready
-> PowerShell 才开始执行用户脚本
```

Linux 使用 `start_new_session=True` 后，session/process group 在 subprocess 创建阶段即可建立，不需要再等待外部 attach。

因此 Linux 版本建议删除：

- `WindowsJob`
- `_create_job_before_deadline()`
- `_assign_job_before_deadline()`
- `WORKSPACE_MCP_JOB_READY_FILE`
- `job.ready`
- PowerShell ready-file wrapper

但仍必须保留“startup 全过程受 operation deadline 约束”的回归保障。

---

## 10. 文件编辑改造：换行符必须正确处理

Linux 版本不能简单规定“所有文件强制 LF”。

Workspace 可能 clone 任意仓库，仓库本身可能有：

- LF 文件；
- CRLF 文件；
- `.gitattributes` 指定的行尾策略；
- 从其他平台提交的已有文件。

### 10.1 `workspaceWriteFile`

当前 API 已有：

```text
line_ending = preserve | lf | crlf
```

保留这个接口。

目标语义：

#### 已有文件 + preserve

保留原文件主要换行风格：

- LF -> LF
- CRLF -> CRLF

#### 新文件 + preserve

Linux 版本默认 LF。

#### 显式 lf / crlf

严格按调用者指定的模式写入。

### 10.2 `workspaceApplyPatch`

当前实现更新已有文件时会先：

```text
CRLF/CR -> LF
```

完成 patch 后直接用 LF 输出。

这会导致只改一行，却把整个 CRLF 文件变成 LF，产生大面积无意义 diff。

Linux 版本必须改为：

```text
读取原文件
   |
检测原主要 newline style
   |
内部统一为 LF 做 patch
   |
应用 hunks
   |
按原 newline style 写回
```

新增文件默认 LF。

### 10.3 mixed newline

不要求逐行精确保留 mixed newline。

建议策略：

- 已有文件判断 predominant style；
- CRLF 占主导则按 CRLF 写回；
- 否则按 LF 写回；
- 文档明确 mixed newline 在 patch 后会被规范成一种主要风格。

### 10.4 必须增加的 newline 回归测试

至少覆盖：

1. CRLF 文件 patch 一行后仍然全文件 CRLF；
2. LF 文件 patch 后仍然 LF；
3. `workspaceWriteFile(preserve)` 覆盖 CRLF 文件仍保持 CRLF；
4. 新文件 + preserve 在 Linux 下使用 LF；
5. 显式 `line_ending=crlf` 仍可创建 CRLF 文件。

### 10.5 仓库级 Git 行尾策略

除了 MCP 文件工具本身的 newline 处理，还要处理 Git checkout/clean 造成的工作树行尾转换。

当前 Windows 审查环境中 `core.autocrlf=true`，可以出现：

```text
Git index: LF
Windows working tree: CRLF
```

Linux 原生分支不应仅依赖开发者本机的 `core.autocrlf`。

实现阶段应评估增加 `.gitattributes`，至少对 Linux 运行所需源码和脚本显式固定 LF，例如：

```gitattributes
*.py   text eol=lf
*.sh   text eol=lf
*.toml text eol=lf
*.yml  text eol=lf
*.yaml text eol=lf
```

是否同时固定 Markdown/JSON 等文件，应以避免无意义全仓库 renormalize diff 为前提单独确认。

尤其需要保证 shell 脚本和 shebang 文件不能因为 Windows checkout 变成 CRLF，否则可能出现：

```text
/bin/bash^M: bad interpreter
```

实施时应使用 `git ls-files --eol` 检查关键文件，并在引入 `.gitattributes` 后审查 `git add --renormalize` 会造成的真实 diff，避免把与 Linux 改造无关的整仓库行尾变化混入提交。

---

## 11. 文件编辑改造：保留 POSIX executable bit

这是 Linux 版本除换行符外必须处理的文件编辑差异。

当前事务写入大致流程为：

```text
写 staged 临时文件
-> 原文件移动到 backup
-> staged 文件 os.replace 到目标位置
```

新的 staged 文件由当前 umask 创建。

在 Linux 上，这可能把原文件：

```text
-rwxr-xr-x script.sh
```

通过一次 `workspaceWriteFile` 或 `workspaceApplyPatch` 后变成：

```text
-rw-r--r-- script.sh
```

即丢失 executable bit。

这在 Windows 上不明显，但 Linux/Git 会把它视为真实 mode change。

### 11.1 目标行为

对已有文件的 overwrite / patch：

- snapshot 时保存原文件 POSIX mode；
- staged 文件提交前或提交后恢复原 mode；
- 至少保证 `stat.S_IMODE(st_mode)` 保持一致；
- 尤其保证 executable bits 不被文本编辑意外修改。

对于新文件：

- 继续使用正常 umask/default mode；
- 本轮不新增“创建可执行文件”的 MCP API；
- 如调用者确实需要新文件 executable，可通过 `workspaceCommand` 执行 `chmod +x`。

### 11.2 必须增加的权限回归测试

至少覆盖：

```text
chmod 755 script.sh
-> workspaceWriteFile overwrite
-> mode 仍为 755
```

以及：

```text
chmod 755 script.sh
-> workspaceApplyPatch
-> mode 仍为 755
```

同时确认普通 `0644` 文件不会被错误改成 executable。

---

## 12. Linux 文件系统相关验证

文件类工具主要基于 `pathlib.Path.resolve()`，整体可以复用，但 Linux 环境需要重新验证：

- `..` 越界拒绝；
- 绝对路径拒绝；
- symlink 指向 Workspace root 外时拒绝；
- symlink 指向 root 内时行为正确；
- 大小写敏感路径按 Linux 文件系统真实语义工作；
- transaction rollback 正常；
- `os.replace` 在目标部署文件系统上保持预期原子语义；
- search/inspect 的路径展示统一使用 POSIX 风格。

Windows 文档中的 `symlink/junction` 在 Linux 版本中统一描述为 `symlink`；junction 是 Windows 专属概念。

---

## 13. 各文件预计改造范围

### `src/workspace_mcp/workspace_operations.py`

大改：

- 删除 `ctypes` / Windows kernel32；
- 删除 `WindowsJob`；
- 删除 `taskkill`；
- PowerShell -> Bash；
- 删除 PowerShell prelude；
- 删除 Windows ready-file attach 流程；
- 使用 POSIX new session/process group；
- 实现 SIGTERM -> grace -> SIGKILL；
- root shell 退出后仍检查/清理普通 descendants；
- 状态字段改为 Linux/process-group 语义；
- 错误信息从 PowerShell 改为 shell/command。

### `src/workspace_mcp/workspace_files.py`

中等改动：

- `WORKSPACE_PWSH_PATH` -> `WORKSPACE_SHELL_PATH`；
- 默认 `/bin/bash`；
- 保留现有 operation limit 配置。

### `src/workspace_mcp/models.py`

小改：

- 处理/移除 `job_assigned`；
- 必要时增加 `process_group_id`。

### `src/workspace_mcp/server.py`

中等改动：

- server instructions 不再写 PowerShell；
- description 改为 Linux shell/Bash；
- `workspaceCommand` title/description 更新；
- 保持 tool schema 和 action 结构基本不变。

### `src/workspace_mcp/workspace_patch.py`

重要的小到中等改动：

- patch 保留已有文件 newline style；
- snapshot/transaction 增加 POSIX mode 保存与恢复；
- 继续保持事务 rollback 语义。

### `.env.example`

改为 Linux 示例，例如：

```text
WORKSPACE_ROOT=/var/lib/workspace-mcp/workspaces
WORKSPACE_OPERATION_ROOT=/var/lib/workspace-mcp/operations
WORKSPACE_SHELL_PATH=/bin/bash
```

### `pyproject.toml`

小改：

- description 从 PowerShell execution 改为 Linux shell/Bash execution；
- 依赖主体预计无需为 Linux runner 新增第三方包。

### `README.md`

大改：

- Windows/PowerShell 说明改为 Linux/Bash；
- 安装命令改为 shell 示例；
- 删除 PowerShell 7 运行时要求；
- 增加 Bash 要求；
- 保留 `rg`、`git`、`gh`；
- 明确 process-group cleanup 边界；
- 明确 `setsid/setpgid/daemonize` 不是第一版 containment 保证；
- 更新文件行尾和 executable-bit 说明；
- 当前阶段不加入 systemd/service 部署章节。

### `MCP_MIGRATION_PLAN.md`

现有文档多处明确写“保留任意 PowerShell”。

Linux 分支实现时需要同步改为：

- arbitrary Linux shell/Bash；
- POSIX process group；
- Linux 验收步骤。

避免设计文档与代码行为互相矛盾。

---

## 14. 测试改造

### 14.1 PowerShell 测试脚本替换

当前测试中的：

- `Write-Output`
- `Start-Sleep`
- `Set-Content`
- `[Console]::OpenStandardOutput()`

改为 Bash/Python 等 Linux 可控方式。

普通输出：

```bash
printf '%s\n' 'hello-mcp'
```

sleep：

```bash
sleep 1
```

文件写入：

```bash
printf '%s\n' 'content' > file
```

需要精确控制 stdout byte/chunk 的 UTF-8 测试，优先用 Python `os.write()` / `sys.stdout.buffer`，避免依赖 shell 的编码和 `printf` 实现细节。

### 14.2 command lifecycle 必测

至少覆盖：

1. 快速成功；
2. 快速失败；
3. slow command 返回 running；
4. `start -> get` 增量日志；
5. stdout/stderr offset 不重复；
6. timeout；
7. cancel；
8. MCP shutdown；
9. idempotent retry；
10. output truncation；
11. root Bash + 普通 child，cancel 后两者都退出；
12. root Bash + 普通 child，timeout 后两者都退出；
13. root Bash 提前退出但同 PGID 后台 child 仍在，operation 完成时 child 被清理；
14. SIGTERM 能正常退出的程序不会无条件直接 SIGKILL；
15. 忽略 SIGTERM 的程序在 grace 后被 SIGKILL。

### 14.3 setsid 边界测试

增加一个受控测试说明：

- child 调用 `setsid()` 后 PGID 会变化；
- 第一版 process-group cleanup 不把该场景声明为可完全 containment；
- 测试 teardown 必须显式终止该 child，禁止留下测试进程。

这个测试用于固定“已知边界”，不是要求第一版把逃逸进程也杀掉。

### 14.4 文件编辑必测

新增：

- LF preserve；
- CRLF preserve；
- patch CRLF 不产生整文件换行 diff；
- executable bit 在 overwrite 后保持；
- executable bit 在 patch 后保持；
- Linux symlink containment；
- case-sensitive path 行为。

---

## 15. 实施顺序

### 阶段 1：文件编辑语义

先修正 Linux 上最容易造成仓库污染的问题：

1. patch 保留 LF/CRLF；
2. overwrite/patch 保留已有 POSIX mode；
3. 增加对应 regression tests。

完成标准：

- 修改 CRLF 文件不会制造整文件 LF diff；
- 修改 executable script 不会产生 Git mode-only change。

### 阶段 2：Linux command runner

1. 删除 Windows Job Object；
2. 配置改为 `WORKSPACE_SHELL_PATH`；
3. Bash subprocess；
4. `start_new_session=True`；
5. 保存 PGID；
6. SIGTERM -> grace -> SIGKILL；
7. 清理 root shell 已退出后的普通 descendants；
8. 删除 ready-file Windows attach 机制。

### 阶段 3：command tests

将现有 PowerShell 测试迁移为 Bash/Python，并补齐：

- PGID cleanup；
- background child；
- timeout/cancel；
- shutdown；
- setsid 已知边界。

### 阶段 4：MCP 语义和配置

更新：

- `server.py` descriptions；
- operation model；
- `.env.example`；
- `pyproject.toml`。

### 阶段 5：文档和真实 Linux 验证

更新：

- README；
- `MCP_MIGRATION_PLAN.md`。

然后必须在真实 Linux 主机执行：

```bash
python -m pytest -q
python -m ruff check .
```

并完成真实 Workspace 流程。

---

## 16. 真实 Linux 验收清单

最终至少验证：

1. Python 3.11+ 环境安装成功；
2. `/bin/bash` 可用；
3. `rg` 可用；
4. `git` 可用；
5. `gh` 使用运行 MCP 的 Linux OS 账户已有认证；
6. MCP initialize 成功；
7. 7 个 Workspace tools 可发现；
8. OAuth 行为与当前版本一致；
9. 创建/复用 Workspace；
10. clone GitHub repo；
11. inspect/search/read 正常；
12. write/patch 正常；
13. CRLF 文件 patch 后仍保持 CRLF；
14. executable 文件 write/patch 后 mode 不变；
15. 快速 Bash command 成功；
16. 长 command 可通过 `start/get` 获取增量日志；
17. timeout 清理普通 process group；
18. cancel 清理普通 process group；
19. 后台普通 child 不残留；
20. stdout/stderr offset 不重复；
21. 日志截断/分页正常；
22. UTF-8 多字节边界正常；
23. MCP shutdown 不遗留普通 command descendants；
24. `git status` 不出现由换行符或 executable bit 误改造成的无意义 diff。

---

## 17. 完成定义

Linux 改造完成需同时满足：

- 不再依赖 PowerShell 7；
- 不再依赖 Windows Job Object / kernel32 / taskkill；
- `workspaceCommand` 默认使用 Bash；
- 普通 command descendants 使用 POSIX session/process group 管理；
- timeout/cancel/shutdown 采用 SIGTERM -> grace -> SIGKILL；
- root shell 提前退出时普通同组 descendants 仍能被回收；
- 明确记录 `setsid/setpgid/daemonize` 的第一版边界；
- `workspaceWriteFile` 正确处理 LF/CRLF；
- `workspaceApplyPatch` 保留已有文件主要换行风格；
- overwrite/patch 保留已有 POSIX executable bit/mode；
- Workspace root containment 在 Linux symlink 环境下通过测试；
- 全部核心测试在真实 Linux 主机通过；
- README、配置、tool description 和实际行为一致；
- 当前版本不要求 systemd/service 化即可直接启动和使用。
