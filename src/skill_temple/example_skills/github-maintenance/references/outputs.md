# Large GitHub outputs in the workspace

读取本文件时，目标是避免把大日志、artifact 内容或长 GitHub 输出直接塞进 `workspaceCommand` stdout。把数据保存到当前 workspace，再用搜索、分段读取或针对性命令缩小信息量。

## 统一目录

默认把临时 GitHub 诊断数据放到：

```text
.gpt-data/github/
  runs/<run-id>/
    logs/
    artifacts/
```

用户指定其他 workspace 相对目录时使用用户目录。诊断目录默认不 staging、不提交。

## 大输出原则

- 小的状态/metadata 优先让 `gh` 返回 JSON，并用 `--jq` 或 PowerShell 只打印所需字段。
- 日志、patch、artifact 清单等可能很大时直接落盘；stdout 只输出文件路径、大小、数量和必要状态。
- 落盘后先 `workspaceSearch` 找错误关键词、测试名、文件名或 stack trace；只对命中附近做 `workspaceReadFiles`。复杂聚合再用 PowerShell/Python 处理文件。
- 二进制、压缩包或未知格式不要用文本读取 Action 硬读；先检查文件类型/大小，再选择对应工具。
- 大命令失败时保留 stderr 和已写入文件，不根据部分文件推断下载完整。

## 保存整个 workflow run 日志

```powershell
$repo = 'OWNER/REPO'
$run = 123456789
$dir = ".gpt-data/github/runs/$run/logs"
$path = Join-Path $dir 'run.log'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

gh run view $run --repo $repo --log 1> $path
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$item = Get-Item $path
[pscustomobject]@{ path = $path; bytes = $item.Length } | ConvertTo-Json -Compress
```

这样日志主体进入 workspace 文件，tool stdout 只包含很小的 metadata。

只关心失败步骤时优先缩小数据量：

```powershell
$path = Join-Path $dir 'failed.log'
gh run view $run --repo $repo --log-failed 1> $path
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item $path | Select-Object FullName,Length
```

## 保存单个 job 日志

先从结构化 run 数据获取 `jobs[].databaseId`，再把目标 job 直接写到文件：

```powershell
$job = 987654321
$path = Join-Path $dir "job-$job.log"
gh run view $run --repo $repo --job $job --log 1> $path
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item $path | Select-Object FullName,Length
```

GitHub CLI 获取整条 run 日志时可能因为 GitHub 平台的 job/log 关联限制退化为逐 job 请求。整条日志失败时，不反复重试同一大请求；改为读取 job IDs，按需要下载失败 job，或逐 job 落盘。

逐 job 保存示例：

```powershell
$jobsJson = gh run view $run --repo $repo --json jobs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$jobs = ($jobsJson | ConvertFrom-Json).jobs

foreach ($job in $jobs) {
    $safeName = [regex]::Replace($job.name, '[^A-Za-z0-9._-]+', '_')
    $path = Join-Path $dir "$($job.databaseId)-$safeName.log"
    gh run view $run --repo $repo --job $job.databaseId --log 1> $path
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Get-ChildItem -File $dir | Select-Object Name,Length
```

如果只需要失败 job，先从 `jobs` 的 `conclusion` 过滤，避免下载无关日志。

## 下载 workflow artifacts

`gh run download` 支持直接指定目标目录，并会把 artifact 内容解压到其中：

```powershell
$repo = 'OWNER/REPO'
$run = 123456789
$dir = ".gpt-data/github/runs/$run/artifacts"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

gh run download $run --repo $repo --dir $dir
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Get-ChildItem -Recurse -File $dir |
    Select-Object FullName,Length
```

只需要特定 artifact 时使用 `--name <name>` 或 `--pattern <glob>`，避免无意义下载全部内容。

需要先判断有哪些 artifact 时，可只读取 metadata：

```powershell
gh api "repos/$repo/actions/runs/$run/artifacts" `
  --jq '.artifacts[] | {id,name,size_in_bytes,expired,created_at,expires_at}'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

## 下载后的分析顺序

1. 先看文件名、数量、大小，不把文件内容整体打印到 stdout。
2. 文本日志用 `workspaceSearch` 搜索错误、exception、失败测试名、源码路径；再分段读取命中位置。
3. JSON/XML/JUnit 等结构化文件可用 PowerShell/Python 提取失败记录和摘要，然后只打印缩减结果。
4. zip、二进制 dump、图片等使用对应工具处理；需要保留原始证据时不要覆写原文件。
5. 得出结论后引用具体 run/job、文件路径和关键命中；不要把“文件存在”当成 CI 结论。
