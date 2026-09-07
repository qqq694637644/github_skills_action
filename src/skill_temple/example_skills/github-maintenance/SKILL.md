---
name: github-maintenance
description: 维护当前持久 Workspace 中的真实 GitHub 仓库并推进代码维护闭环。Use for repository investigation, code changes, git branches/commits/pushes, pull request lifecycle, GitHub Actions/CI, workflow dispatch or reruns, logs, artifacts, and caches when current repo or GitHub state matters. 不用于无需真实仓库或 GitHub 状态的纯编程问答。
---

# GitHub maintenance

目标是把仓库维护任务推进到可验证的调查结论、本地修改、PR/CI 状态或用户明确要求的远端结果。使用 Workspace Actions 处理文件和命令，使用 `git` / `gh` 获取真实仓库与 GitHub 状态；不要从旧状态或命令意图推断完成。

## 按任务加载引用

- 仓库状态、branch、commit、push、PR 查询/创建/更新/merge：读取 `references/git-and-pr.md`。
- checks、workflow runs/jobs、dispatch/rerun/watch、workflow 文件、Actions cache：读取 `references/actions.md`。
- workflow/job 大日志、artifact 或其他大 GitHub 输出：读取 `references/outputs.md`。
- 只加载当前任务需要的组合；通用代码定位、读取和编辑仍按全局 Workspace 工作循环执行。

## 任务路由

### 只读调查

读取真实仓库状态、相关代码和必要的 GitHub 远端状态后报告结论。不要创建 branch、修改文件、commit、push 或改变 PR/workflow 状态。

### 修改仓库代码

读取 `references/git-and-pr.md`。先确认 repo、默认分支和工作树；如果需要编辑且当前位于默认分支，用户未指定 branch 时创建 `gpt/<short-topic>` 任务分支。随后按 Discover → Search → Read 定位影响范围，修改并运行相关验证，最后检查真实 diff。

只有当用户要求 commit/push/PR 等远端交付物，或当前任务明确是在继续已有远端对象时才发布；否则保留已验证的 workspace 修改并报告状态。

### 继续已有 PR

读取 `references/git-and-pr.md`，并在需要 checks 时读取 `references/actions.md`。先查询 PR 的真实 state、base、head branch 和 head SHA，再同步/checkout 对应 head 后修改。验证和 diff 完成后，按当前 PR 任务需要 commit/push；push 后重新读取 PR head 和 checks，不能复用 push 前的 SHA 或 CI 状态。

### 诊断或修复 CI

读取 `references/actions.md`；日志或 artifact 较大时再读 `references/outputs.md`。先用当前 branch/PR 的 head SHA 定位匹配的失败 run/job，再读取最小必要日志并回到源码、测试或 workflow 查根因。修复后运行本地验证；如果任务包含 push，必须以新的 head SHA 重新查询 CI。只有真实 run/check 成功时才能报告 CI 通过。

### Workflow / Actions 操作

读取 `references/actions.md`。dispatch、rerun、cache 删除等外部状态改变只在用户要求相应操作时执行。操作后重新查询 run/job/cache 的真实状态；触发成功不等于 workflow 成功。

### Merge、close 与历史改写

merge、close PR、删除远端状态、force push 或历史改写只在用户明确要求时执行。操作前重新读取当前 PR/branch/head 状态，并使用能够绑定已知 head 的保护机制；操作后重新查询结果。

## 证据与停止条件

- GitHub 当前状态优先使用 `gh ... --json` 或其他结构化结果，并核对 repo、branch/PR、head SHA、run/job 标识；旧状态不能当作当前事实。
- PowerShell 中关键 native command 失败必须让 operation 失败，避免后续命令覆盖 `$LASTEXITCODE`。
- 大输出先写入 workspace，再用 `workspaceSearch` 定位错误、测试名、源码路径或 stack trace，之后只读取必要片段。
- 不输出 token、credential、secret、private key；诊断下载目录默认不 staging、不提交。
- 已取得用户要求的结果并有足够证据后停止；权限、保护分支、远端冲突、缺失工具或无法验证的状态作为真实阻塞报告。
