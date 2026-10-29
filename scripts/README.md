# Windows 服务管理与停机流程

此目录中的 `windows_service_manager.py` 是受 Git 版本控制的**服务管理器实现**。
外层 `C:\Users\Administrator\Desktop\git_skill\manage.py` 是轻量启动入口；
`start.bat`、`status.bat`、`stop.bat` 仍放在 `git_skill` 目录下。

## 新版启动和关闭

- `start.bat`：通过 Python 监督 FRPC、Caddy、Workspace MCP。
- `status.bat`：只读检查监督进程、启动器以及服务 PID。
- `stop.bat`：向监督进程发送 Windows 本地事件，由监督进程执行有序停止。
- 监督进程的 `Q` / Ctrl+C 与 `stop.bat` 进入同一停止流程。
- 停止顺序：MCP → Caddy → FRPC。MCP 收到独立本地事件后
  由 Uvicorn 运行 ASGI lifespan 的 shutdown 逻辑，再回收运行的 workspaceCommand。
- 每个服务通过受控 Python 启动器，在绑定 Windows Job Object 之后才放行实际服务进程。
  正常关停和超时回收都会关闭 Job，避免带有子进程的 Python/Pwsh 残留。
- 若清理失败，保留 `services.json` 和临时进程信息以便排查。

## 从旧 PowerShell 版本迁移

**首次迁移需手动停一次旧服务**。旧版 `services.json` 是一个数组，不包含
新版 Windows 控制事件。新版 `stop.bat` 会拒绝自动强杀旧服务；
这是为了防止在缺乏进程树登记时再次产生孤儿进程。

1. 在运行旧 `manage.ps1` 的原始窗口中按 `Q` 停止旧版本
   （旧实现本身仍会使用 taskkill，不能实现新版优雅关闭）。
2. 使用 `py -3 manage.py status` 核对旧服务已结束，并单独检查
   是否还有早先启动的 FRPC/Python/Pwsh 实例。不要盲目杀掉所有 Python 进程。
3. 执行 `start.bat` 启动新版，之后正常使用 `stop.bat`。

旧脚本保存在 `git_skill\manage.legacy.ps1`，并有独立的文件备份。
此次代码变更没有自动重启线上 MCP，也没有更改现有的 `services.json`。

## 依赖和测试

运行环境：Windows、Python 3.11+、PowerShell 7、`rg`、`git`，可选 `gh`。

在仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_shutdown_lifecycle.py
.\.venv\Scripts\python.exe -m ruff check src/workspace_mcp/server.py src/workspace_mcp/workspace_operations.py src/workspace_mcp/shutdown_control.py scripts/windows_service_manager.py tests/test_shutdown_lifecycle.py
```

测试使用独立的临时 Windows Job、子进程以及仅回环地址的临时 Uvicorn，
不会启动、停止或重启线上的 FRPC/Caddy/MCP。

## 安全边界

停机通知使用随机命名的 Windows `Local` Event，由本机 OS 账户默认
DACL 约束，**没有增加公网停机 API**。任意 Workspace PowerShell
脚本未必响应 Ctrl+Break，因此「正常通知 → 宽限期 → Job 强制兜底」
是有意保留的两阶段方案，并非承诺任意用户脚本都能自行优雅退出。
