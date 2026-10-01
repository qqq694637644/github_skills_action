# Workspace Actions contract

只在仓库维护任务需要 Workspace 文件写入、Patch、PowerShell，或 Action 调用因 schema/参数失败时读取本文件。OpenAPI schema 是最终参数契约；调用被拒绝时修正参数，不重复同一个无效请求。

## 路由

- 未知目录先 `workspaceInspect`，未知实现位置用 `workspaceSearch`。
- 已知文件在修改前先 `workspaceReadFiles`。
- 单个已知 UTF-8 文件完整创建/覆盖用 `workspaceWriteFile`。
- 有界的局部或多文件文本修改用 `workspaceApplyPatch`。
- PowerShell、git、gh、测试、构建和项目 CLI 用 `workspaceCommand`。

## workspaceApplyPatch

`patch` 是原始 Workspace Patch 文本，不是普通 git/unified diff，也不要包 Markdown code fence。

必须使用以下 envelope：

```text
*** Begin Patch
...
*** End Patch
```

更新文件：

```text
*** Begin Patch
*** Update File: path/to/file.py
@@
-old line
+new line
*** End Patch
```

规则：

- `*** Update File: <path>` 后至少有一个 `@@` hunk；hunk 行必须以空格、`+` 或 `-` 开头。
- `*** Add File: <path>` 的每一行文件内容必须以 `+` 开头。
- `*** Delete File: <path>` 仅在 `allow_delete=true` 时允许，section 内不能有文件内容。
- 不要发送 `diff --git`、`--- a/...`、`+++ b/...`。
- 较大或格式敏感的 Patch 先用 `dry_run=true`；真实应用后仍要检查实际 `git diff`。

## workspaceWriteFile

- `mode=overwrite_if_sha256_matches` 时必须传 `expected_sha256`。
- `line_ending=preserve`：已有文件按其主要 LF/CRLF 风格保存；新文件统一使用 LF。
- `line_ending=lf` / `crlf`：显式强制对应行尾。
- 所有文件类 Action 的路径都必须保持在 Workspace root 内；绝对路径、`..` 逃逸和最终解析到 root 外的 symlink/junction 都会被拒绝。

## workspaceCommand

每次调用都必须传 `action`：

- `action=start`：需要 `idempotency_key`、`workspace_id`、`script`。
- `action=get`：需要 `operation_id`，并把上次返回的 `next_stdout_offset` / `next_stderr_offset` 传回以获取增量日志。
- `action=logs`：需要 `operation_id`，只用于历史日志重读或分页。
- `action=cancel`：需要 `operation_id`。
- `action=list`：可选按 `state` 过滤。

`start` 可能同步完成，也可能返回 `running`。返回 `running` 时继续用 `get` 到终态。PowerShell 中关键 native command 失败后立即检查 `$LASTEXITCODE`，避免后续命令覆盖失败状态。
