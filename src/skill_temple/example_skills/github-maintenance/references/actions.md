# GitHub Actions control plane

只在任务涉及 checks、workflow runs/jobs、dispatch/rerun/watch、workflow 文件或 Actions cache 时读取本文件。日志和 artifact 下载另读 `outputs.md`。

## 身份与仓库

需要确认当前 GitHub 身份或仓库时，使用已有 `gh` 登录态：

```powershell
gh api user --jq .login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
gh repo view --json nameWithOwner,url,defaultBranchRef
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果失败，保留实际 stderr 并报告认证、权限、网络或仓库上下文问题；不要要求把 token 粘贴到聊天中。

## PR checks

PR 场景优先直接查 checks：

```powershell
gh pr checks 123 --json bucket,name,state,workflow,link
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

区分 pass、fail、pending、skipping、cancel；没有失败项不等于全部完成。

## 找到正确的 workflow run

按当前任务最强的标识过滤，优先 commit SHA，其次 branch/workflow：

```powershell
gh run list --commit '<sha>' --limit 20 --json databaseId,status,conclusion,workflowName,headSha,event,createdAt,url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

也可以使用 `--branch`、`--workflow`、`--event`、`--status` 等过滤。选 run 时核对 workflow、head SHA/branch、event 和创建时间，不把旧 run 当成当前结果。

查看 run/job 结构化状态：

```powershell
gh run view 123456789 --json attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,jobs,status,updatedAt,url,workflowName
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要 job ID 时读取 `jobs[].databaseId`；它也是 `gh run rerun --job` 使用的 ID，不要从浏览器 URL 猜。

## 等待

只有任务需要等到 run 终态时才 watch：

```powershell
gh run watch 123456789 --compact --exit-status
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

如果 workspace operation 自身 timeout，只能报告执行器超时；不要由此推断 GitHub run 的最终状态，必要时重新 `gh run view`。

## Rerun

先确认 run/job 对应当前任务，再选择最小范围：

```powershell
# 仅失败 jobs
gh run rerun 123456789 --failed
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 单 job
gh run rerun 123456789 --job 987654321
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要整条 rerun 时使用 `gh run rerun <run-id>`。请求成功后重新查询 attempt/status；“rerun 已提交”不等于 CI 已通过。

## Workflow dispatch

先确认 workflow 和目标 ref：

```powershell
gh workflow list --all --json id,name,path,state
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

gh workflow run 'ci.yml' --ref 'main' -f mode=full
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

`gh workflow run` 可能返回新 run URL，但不要依赖它一定给出可用 run ID。触发后按 workflow/ref/时间重新查询；如果没有唯一匹配项，就明确说未定位到匹配 run。

## Workflow 文件维护

`.github/workflows/*.yml` / `*.yaml` 按普通项目文本文件处理：读取和修改使用 Workspace file Actions，验证使用项目已有测试、`actionlint`（若已安装）以及 workflow 调用脚本的相关 smoke test。

不要为了简单校验引入与项目无关的新依赖。无法本地验证 GitHub 服务端行为时，说明未验证项。

## Actions cache

结构化列出 cache：

```powershell
gh cache list --limit 100 --json id,key,ref,sizeInBytes,createdAt,lastAccessedAt,version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

需要删除时可按 ID 或 key/ref 精确处理：

```powershell
gh cache delete 1234
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

大范围 cache 操作后重新 list 验证实际结果。

## CI 修复闭环

1. 用 PR checks 或 run list 定位与当前 head SHA 对应的失败 run/job。
2. 日志可能很大时加载 `outputs.md`，把日志保存到 workspace 后针对性搜索。
3. 回到源码、测试或 workflow 定位根因并修改。
4. 运行相关本地验证，检查实际 diff。
5. 如果任务包含发布，commit/push 后以新 head SHA 重新查 CI。
6. 只有实际查询到新 run 的成功结论时才报告 CI 已通过。
