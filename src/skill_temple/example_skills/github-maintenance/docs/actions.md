# GitHub Actions, workflows, logs, artifacts, and caches

只在任务需要 GitHub Actions 实时状态或远端 workflow 操作时读取本文件。所有 `gh` 命令都需要 `workspaceCommand(..., allow_network=true)`。

## GitHub CLI 可用性

不要调用 runtime 禁止的 `gh auth`。用普通只读 API 请求验证已有登录态：

```powershell
gh api user --jq .login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果失败，保留真实 stderr 并报告登录态、网络或权限阻塞，不要求用户把 token 粘贴到聊天里。

## PR checks

针对 PR，优先直接读取 checks：

```powershell
gh pr checks 123 --json bucket,name,state,workflow,link
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

`bucket` 便于区分 `pass`、`fail`、`pending`、`skipping`、`cancel`。不要只因为没有失败项就声称 CI 已完成；仍要区分 pending 与 pass。

## Workflow run 列表

按 branch：

```powershell
gh run list --branch 'gpt/example-task' --limit 20 --json databaseId,status,conclusion,workflowName,headSha,event,createdAt,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

按 commit SHA：

```powershell
gh run list --commit '<sha>' --limit 20 --json databaseId,status,conclusion,workflowName,headSha,event,createdAt,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

按 workflow：

```powershell
gh run list --workflow 'ci.yml' --branch 'main' --limit 20 --json databaseId,status,conclusion,workflowName,headSha,event,createdAt,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

选择 run 时同时核对 workflow、head SHA/branch、event 和时间，避免把同名 branch 上的旧 run 当成当前结果。

## Run 与 job 明细

Run：

```powershell
gh run view 123456789 --json attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,jobs,status,updatedAt,url,workflowName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

只取 job ID 与名称：

```powershell
gh run view 123456789 --json jobs --jq '.jobs[] | {name,databaseId,status,conclusion}'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

GitHub CLI 的 job rerun 使用 `jobs[].databaseId`，不要从浏览器 URL 中猜 job ID。

## 日志

失败步骤日志：

```powershell
gh run view 123456789 --log-failed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

指定 job 的完整日志：

```powershell
gh run view 123456789 --job 987654321 --log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

日志很大时先获取失败日志或单个 job，不要无条件拉取整条 run 的全部日志。把日志中的错误与实际源码/配置对应后再修改代码。

## 等待 run

只有当前请求确实需要等待结果时才使用 watch，并给 `workspaceCommand` 合理 timeout：

```powershell
gh run watch 123456789 --exit-status
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果 operation 自身超时，报告 timeout；不要把它解释成 CI 失败或成功。

## Rerun

Rerun 是远端写操作。先确认选中的 run/job 与当前任务匹配。

只重跑失败 jobs：

```powershell
gh run rerun 123456789 --failed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

重跑单 job：

```powershell
gh run rerun 123456789 --job 987654321
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

整条 rerun：

```powershell
gh run rerun 123456789
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Rerun 请求成功后重新 `gh run view` / `gh run list` 获取新的 attempt 或状态；不要把“已提交 rerun 请求”写成“CI 已通过”。

## Workflow dispatch

列出 workflows：

```powershell
gh workflow list --all --json id,name,path,state
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

触发 `workflow_dispatch`：

```powershell
gh workflow run 'ci.yml' --ref 'main' -f mode=full
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

`gh workflow run` 不应被当成 run ID 来源。触发后通过 workflow + ref + 时间窗口重新查询：

```powershell
gh run list --workflow 'ci.yml' --branch 'main' --limit 10 --json databaseId,status,conclusion,headSha,event,createdAt,url,workflowName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果没有找到可唯一关联的新 run，就明确说“未找到匹配 run”，不要猜 ID。

## Workflow 文件维护

`.github/workflows/*.yml` / `*.yaml` 是普通项目文本文件：用 Workspace read/search/edit Actions 修改，而不是在 PowerShell 中拼接覆盖。

验证顺序按项目现状选择：

1. 项目已有 workflow/schema 测试时运行它。
2. 已安装 `actionlint` 时运行目标 workflow 或全量 workflow lint。
3. 运行与 workflow 所调用脚本直接相关的本地 smoke test。
4. 无本地验证工具时，至少检查 diff 与 YAML 结构，并明确说明未能执行 GitHub 服务端验证。

不要为了验证而自动安装未知第三方工具，除非任务范围允许。

## Artifacts

下载指定 run 的 artifacts 到 workspace 内的临时目录，便于后续使用 Workspace Actions 检查：

```powershell
$run = 123456789
$dir = ".gpt-artifacts/runs/$run"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
gh run download $run -D $dir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem -Recurse -File $dir | Select-Object FullName,Length
```

之后根据任务用 `workspaceInspect`、`workspaceSearch`、`workspaceReadFiles` 或必要的解析命令分析下载内容。

`.gpt-artifacts/` 是诊断材料，不要因为它存在就 staging。提交时显式 `git add -- <task paths>`。

需要先查看 artifact 元数据时，可使用 GitHub API：

```powershell
$repo = gh repo view --json nameWithOwner --jq '.nameWithOwner'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$run = 123456789
gh api "repos/$repo/actions/runs/$run/artifacts" --jq '.artifacts[] | {id,name,size_in_bytes,expired,created_at,expires_at}'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果下载失败、artifact 已过期或权限不足，报告原始事实，不做“应该已经下载”的兜底推断。

## Actions cache

列出 cache：

```powershell
gh cache list --limit 100 --json id,key,ref,sizeInBytes,createdAt,lastAccessedAt,version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

按 branch/ref 过滤：

```powershell
gh cache list --ref 'refs/heads/main' --json id,key,ref,sizeInBytes,lastAccessedAt
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

删除单个 cache：

```powershell
gh cache delete 1234
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

按 key/ref 删除：

```powershell
gh cache delete 'cache-key' --ref 'refs/heads/main'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

`gh cache delete --all` 会大范围删除远端缓存。只有请求范围明确包含这种删除时才使用；完成后重新 `gh cache list` 验证实际结果。

## CI 修复闭环

失败 CI 的最短闭环：

1. 用 PR checks 或 run list 找到与当前 head SHA 对应的失败 run。
2. 读取失败 job/step 日志；只有需要时再下载 artifact。
3. 回到 workspace 定位对应源码、测试或 workflow；做最小修复。
4. 运行本地相关验证并检查 diff。
5. 如果请求包含发布，commit/push 后以新的 head SHA 重新查 CI。
6. 只有新 run 的实际结论为 success/pass 时，才报告 CI 已通过。
