# Git, branches, commits, pushes, and pull requests

只在任务涉及 Git/PR 生命周期时读取本文件。命令均按 PowerShell 7 写法。

## 先确认本地与远端身份

本地事实：

```powershell
git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git status --short --branch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git remote -v
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要 GitHub 实时信息时使用 `allow_network=true`：

```powershell
gh api user --jq .login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gh repo view --json nameWithOwner,url,defaultBranchRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

`gh api user` 只是利用已经配置好的 GitHub CLI 登录态；不要调用被 runtime 禁止的 `gh auth`，也不要读取 token。

## Branch 选择

优先遵守用户指定 branch。没有指定时，根据任务判断是否继续当前任务 branch；如果准备从默认 branch 发布新改动，再创建一个短的任务 branch。`gpt/<slug>` 可以作为默认命名习惯，但不是硬要求。

创建 branch 前确认当前未提交修改不会被覆盖：

```powershell
git status --porcelain=v1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

获取默认 branch：

```powershell
$defaultBranch = gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

从最新远端默认 branch 创建任务 branch：

```powershell
$base = 'main'
$branch = 'gpt/example-task'
git fetch origin $base
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git switch -c $branch "origin/$base"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

不要在有用户未提交修改时为了切 branch 使用 `reset --hard`、`clean -fd` 或强制 checkout。

## 继续已有 PR

先读取 PR，确认实际 head/base/state，再决定 checkout：

```powershell
$pr = 123
gh pr view $pr --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,title
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果需要切到 PR branch，先确认工作树不会丢失现有修改，然后：

```powershell
gh pr checkout $pr
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

不要使用 `gh pr checkout --force` 清掉用户本地状态。

## 修改后的本地检查

Workspace Actions 完成文本修改后，用本地 Git 检查最终状态：

```powershell
git status --short
git diff --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --stat
git diff
```

根据项目实际情况另外运行最相关的测试、lint、类型检查或构建。不要因为全量测试很贵就跳过明显可运行的定向验证，也不要把未运行的检查写成通过。

## 精确 staging 与 commit

存在无关本地改动时，不要 `git add -A`。显式 staging 当前任务文件：

```powershell
git add -- path/to/file1 path/to/file2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --cached --stat
git diff --cached
```

确认 staged diff 正确后提交：

```powershell
git commit -m 'Describe the maintenance change'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

把输出 SHA 当作后续 push/PR 的实际 commit 证据。

## Push

普通 push 依赖 Git 自身 fast-forward 检查，不主动覆盖远端：

```powershell
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push --set-upstream origin "HEAD:refs/heads/$branch"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果远端拒绝 non-fast-forward，先 `git fetch` 并读取差异，再决定 rebase/merge；不要自动强推。

只有当前授权范围确实包含 force push 时才使用 lease，并绑定已知旧 SHA，而不是裸 `--force`：

```powershell
$branch = git branch --show-current
$expected = '<previously-verified-remote-sha>'
git push origin "HEAD:refs/heads/$branch" "--force-with-lease=refs/heads/$branch:$expected"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果不能提供之前实际查询过的 `expected`，不要把 force-with-lease 当作普通 push 的替代品。

## PR 查询

列出候选 PR：

```powershell
gh pr list --state open --json number,title,headRefName,baseRefName,isDraft,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

查看一个 PR 的完整维护状态：

```powershell
gh pr view 123 --json number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

查看改动文件或 patch：

```powershell
gh pr diff 123 --name-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要 patch 时去掉 `--name-only`。

## 创建 PR

先完成 push。创建时显式提供 base/head，并让正文描述实际修改和验证：

```powershell
$body = @'
## Summary
- change one
- change two

## Validation
- test command / result
'@

gh pr create --base main --head 'gpt/example-task' --title 'Fix example' --body $body
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

创建后立即查询真实 URL/head SHA：

```powershell
gh pr view --json number,url,state,isDraft,headRefName,headRefOid,baseRefName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

## 更新、评论与关闭 PR

更新标题、正文或 base：

```powershell
gh pr edit 123 --title 'Updated title' --body 'Updated body'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

评论：

```powershell
gh pr comment 123 --body 'Maintenance update'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

关闭：

```powershell
gh pr close 123
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

不要默认附加 `--delete-branch`。关闭 PR 与删除 branch 是不同动作。

## Merge PR

合并前重新读取 PR；不要复用很早之前看到的 head SHA：

```powershell
$pr = gh pr view 123 --json number,url,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$pr | ConvertTo-Json -Depth 6
```

确认当前请求允许合并、PR 仍然 open 且非 draft，并选择用户要求的策略。使用 GitHub CLI 的 head-match 保护并绑定刚查询到的 SHA：

```powershell
$head = $pr.headRefOid
gh pr merge 123 --squash --match-head-commit $head
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

策略可替换为 `--merge` 或 `--rebase`。除非任务明确要求，不添加 `--admin`、`--auto` 或 `--delete-branch`。

合并后重新查询结果：

```powershell
gh pr view 123 --json state,mergedAt,mergeCommit,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

只有这里返回的实际状态和 merge commit 才能作为最终合并证据。
