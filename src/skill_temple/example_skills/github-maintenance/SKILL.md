---
name: github-maintenance
description: 使用当前持久 Workspace 中的 git 与 GitHub CLI 维护 GitHub 仓库。Use for branches, commits, pushes, pull requests, GitHub Actions runs/jobs/checks/logs, workflow dispatch or reruns, artifacts, caches, and CI diagnosis. 不用于无需仓库或 GitHub 实时状态的普通编程问答。
---

# GitHub maintenance

直接组合 Workspace Actions、PowerShell 7、`git` 和 `gh`。Workspace 是持久工作目录，不绑定仓库或 branch；同一任务优先复用现有 workspace 和 checkout。

## 按需加载

- Git branch/commit/push、PR 查询/创建/更新/merge：读取 `references/git-and-pr.md`。
- Actions checks/runs/jobs、workflow dispatch/rerun/watch、workflow 文件维护、cache：读取 `references/actions.md`。
- workflow/job 日志、artifact、或任何可能产生大输出的 GitHub 操作：读取 `references/outputs.md`。
- 同一任务涉及多个领域时只加载需要的组合，不为普通本地编辑加载 GitHub 资料。

## GitHub 约定

- `gh` 由宿主预先安装并登录；需要确认身份时用 `gh api user --jq .login`。不要输出 token、credential 或 secret 值。
- GitHub 实时状态以实际 `git` / `gh` 查询结果为准。远端写操作完成后读取结果再报告，不从命令意图推断成功。
- PowerShell 中关键 native command 失败时让 operation 失败；不要让后续命令掩盖非零 `$LASTEXITCODE`。
- 可能很大的 stdout 不直接回传给模型：写到当前 workspace 的诊断目录，只在 stdout 返回路径、大小和少量摘要，再用 Workspace search/read 或针对性命令分析。
- 诊断下载目录不属于代码改动；提交时按任务范围显式选择文件。
