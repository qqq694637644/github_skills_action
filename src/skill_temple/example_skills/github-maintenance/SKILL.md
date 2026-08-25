---
name: github-maintenance
description: 维护当前 Workspace 中的 GitHub 仓库并推进真实代码维护工作。Use for repository investigation, code changes, git branches/commits/pushes, pull requests, PR continuation/review/comments/close/merge, GitHub Actions runs/jobs/logs, workflow dispatch or reruns, artifacts, and Actions caches. 也用于诊断失败 CI、继续已有 PR、发布已经完成的本地修改。不要用于不需要仓库或 GitHub 实时状态的纯编程问答。
---

# GitHub maintenance

把 Workspace Actions 当作文件与执行边界，把 `workspaceCommand` 当作 PowerShell 7 执行器。优先直接组合现有 Actions、`git` 和 `gh`；已有工具能可靠完成时，不创建额外 helper script。

## 路由

- branch、commit、push、PR、PR continuation/review/comment/close/merge：按需读取 `docs/git-and-pr.md`。
- GitHub Actions、CI、workflow、job/log、rerun/dispatch、artifact、cache：按需读取 `docs/actions.md`。
- 两类都涉及时读取两份；纯本地代码调查或文本修改不需要为了 GitHub 操作加载这些 docs。

## GitHub 运行约束

- 远端 GitHub 能力依赖宿主预先安装并配置好 `gh`。Skill 不执行 `gh auth` / `gh secret`，也不请求或打印凭据；用 `gh api user --jq .login` 验证现有登录态。
- 访问 GitHub 或 Git remote 的 `workspaceCommand` 使用 `allow_network=true`；纯本地命令不申请网络。
- 远端写入前确认当前 workspace 对应目标仓库；远端写入后重新查询实际状态，不根据命令意图推断成功。
- 关键 `git` / `gh` / test native command 后检查 `$LASTEXITCODE`，确保失败的 command 让 operation 失败。
- 保留与当前任务无关的本地修改；只 stage 当前任务文件，不用 reset/clean 获取“干净”工作树。
