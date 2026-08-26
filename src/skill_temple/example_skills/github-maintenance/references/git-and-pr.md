# Git and pull requests

只在任务涉及 Git branch、commit、push 或 PR 生命周期时读取本文件。命令按 PowerShell 7 写法。

## 确认当前仓库

```powershell
git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git status --short --branch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gh repo view --json nameWithOwner,url,defaultBranchRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

同一个 workspace 可以长期复用并自由 `fetch` / `switch` branch。切换前先看工作树，保留与当前任务无关的未提交修改。

## Branch 与已有 PR

获取最新远端状态后再基于目标 branch 工作：

```powershell
git fetch origin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

继续已有 PR 时先读真实 head/base/state：

```powershell
$pr = 123
gh pr view $pr --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,title
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要 checkout 时可直接：

```powershell
gh pr checkout $pr
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果本地改动会与切换冲突，先处理当前任务状态；不要为了方便清掉未知修改。

## 修改、验证、提交

文本修改使用 Workspace edit Actions；命令、测试和 Git 检查使用 PowerShell。提交前至少确认实际 diff：

```powershell
git status --short
git diff --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --stat
git diff
```

运行与改动直接相关的测试、lint、类型检查或构建。只把实际运行过的验证写进最终结果。

存在无关修改时显式 staging 当前任务文件：

```powershell
git add -- path/to/file1 path/to/file2
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git diff --cached --stat
```

提交后读取真实 SHA：

```powershell
git commit -m 'Describe the change'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

## Push

普通 push 直接依赖 Git fast-forward 语义：

```powershell
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git push --set-upstream origin "HEAD:refs/heads/$branch"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

遇到 non-fast-forward 时先 fetch 并检查差异，再根据任务选择 rebase、merge 或其他处理。

如果确实需要覆盖远端历史，优先绑定已知远端 SHA 的 `--force-with-lease`，避免裸 `--force`：

```powershell
$branch = git branch --show-current
$expected = '<verified-remote-sha>'
git push origin "HEAD:refs/heads/$branch" "--force-with-lease=refs/heads/$branch:$expected"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

## PR 查询与创建

列出或查看 PR 时优先请求结构化字段：

```powershell
gh pr list --state open --json number,title,headRefName,baseRefName,isDraft,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

gh pr view 123 --json number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

创建 PR 前完成 push，并让正文反映真实修改和验证。创建后重新读取 PR：

```powershell
gh pr create --base main --head 'feature/example' --title 'Describe the change' --body 'Summary and validation'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gh pr view --json number,url,state,isDraft,headRefName,headRefOid,baseRefName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

更新、评论或关闭可直接使用 `gh pr edit`、`gh pr comment`、`gh pr close`，完成后按任务需要重新查询状态。

## Merge

合并前重新读取当前 PR head，而不是复用早先看到的 SHA：

```powershell
$pr = gh pr view 123 --json state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$head = $pr.headRefOid
gh pr merge 123 --squash --match-head-commit $head
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gh pr view 123 --json state,mergedAt,mergeCommit,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

按用户目标把 `--squash` 换成 `--merge` 或 `--rebase`。最终以重新查询到的 PR 状态和 merge commit 为准。
