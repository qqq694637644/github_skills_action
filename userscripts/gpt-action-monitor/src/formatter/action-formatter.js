export function parseField(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(
    new RegExp(`(?:^|\\s)${escaped}=("(?:\\\\.|[^"\\\\])*"|\\[[^\\]]*\\]|[^\\s]+)`),
  );
  if (!match) return null;
  const raw = match[1];
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function baseName(path) {
  if (!path || typeof path !== 'string') return '';
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function compactList(value, max = 2) {
  if (!Array.isArray(value) || !value.length) return '';
  const names = value.slice(0, max).map((item) => baseName(String(item)));
  return value.length > max ? `${names.join(', ')} +${value.length - max}` : names.join(', ');
}

function shorten(value, limit = 72) {
  if (value === null || value === undefined) return '';
  const oneLine = String(value).replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

export function summarize(text) {
  const action = text.match(/\bACTION\s+([\w-]+)/)?.[1] || 'Action';
  const time = text.match(/^\[\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})\]/)?.[1] || '';
  let detail = '';

  if (action === 'loadSkills') detail = compactList(parseField(text, 'skill_ids'));
  else if (action === 'readSkillContent') detail = baseName(parseField(text, 'path'));
  else if (action === 'workspaceReadFiles') detail = compactList(parseField(text, 'paths')) || `${parseField(text, 'files') || ''} files`;
  else if (action === 'workspaceSearch') detail = shorten(parseField(text, 'query'));
  else if (action === 'workspaceInspect') detail = compactList(parseField(text, 'paths'));
  else if (action === 'workspaceWriteFile') detail = baseName(parseField(text, 'path'));
  else if (action === 'workspaceApplyPatch') {
    const files = parseField(text, 'changed_files');
    detail = Array.isArray(files) ? `${files.length} files · ${compactList(files)}` : '';
  } else if (action === 'workspaceCommand') {
    const commandAction = parseField(text, 'action');
    const command = parseField(text, 'command');
    const state = parseField(text, 'state');
    const exitCode = parseField(text, 'exit_code');
    if (command) {
      const status = [commandAction, state].filter(Boolean).join(' · ');
      const exit = state === 'failed' && exitCode !== null ? ` · exit ${exitCode}` : '';
      detail = `${status}${exit}${status ? ' · ' : ''}${shorten(command, 48)}`;
    } else if (state && commandAction) detail = `${commandAction} · ${state}`;
    else detail = shorten(state || commandAction || '');
  } else {
    detail = shorten(parseField(text, 'path') || parseField(text, 'query') || compactList(parseField(text, 'paths')) || parseField(text, 'state') || '');
  }

  return { action, detail: detail || 'completed', time, raw: text };
}
