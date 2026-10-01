const PREVIEW_LINES = 3;
const JSON_DIAGNOSTIC_LIMIT = 100;
const jsonDiagnostics = new Set();

function rememberJsonDiagnostic(key) {
  if (jsonDiagnostics.has(key)) return false;
  jsonDiagnostics.add(key);
  if (jsonDiagnostics.size > JSON_DIAGNOSTIC_LIMIT) {
    const oldest = jsonDiagnostics.values().next().value;
    jsonDiagnostics.delete(oldest);
  }
  return true;
}

function reportJsonDiagnostic(cell, raw, outcome, formatted = '') {
  const rawPreview = String(raw || '').slice(0, 800);
  const key = `${cell.id}:${cell.revision}:${outcome}:${rawPreview}`;
  if (!rememberJsonDiagnostic(key)) return;
  console.debug('[GPT Action Monitor][Activity JSON]', {
    activityId: cell.id,
    phase: cell.phase,
    command: cell.payload?.command || '',
    outcome,
    raw: rawPreview,
    formatted: String(formatted || '').slice(0, 800),
  });
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1) return scalarText(entries[0][1]);
    return `${entries.length} fields`;
  }
  return String(value ?? '');
}

function summarizeJson(value) {
  if (Array.isArray(value)) return `${value.length} items`;
  if (!value || typeof value !== 'object') return scalarText(value);
  const entries = Object.entries(value);
  const priority = [
    'state', 'number', 'title', 'nameWithOwner', 'defaultBranchRef',
    'baseRefName', 'headRefName', 'url',
  ];
  entries.sort(([left], [right]) => {
    const leftRank = priority.indexOf(left);
    const rightRank = priority.indexOf(right);
    if (leftRank < 0 && rightRank < 0) return 0;
    if (leftRank < 0) return 1;
    if (rightRank < 0) return -1;
    return leftRank - rightRank;
  });
  const parts = entries.slice(0, 3).map(([key, nested]) => `${key}: ${scalarText(nested)}`);
  if (entries.length > 3) parts.push('…');
  return parts.join(' · ');
}

function readableOutputLine(cell, line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return '';
  if (/^[\[\]{}],?$/.test(trimmed)) {
    reportJsonDiagnostic(cell, trimmed, 'json-syntax-hidden');
    return '';
  }
  const looksLikeJsonContainer = trimmed.startsWith('{')
    || /^\[\s*(?:[\]{"\d\-tfn])/.test(trimmed);
  if (looksLikeJsonContainer) {
    try {
      const formatted = summarizeJson(JSON.parse(trimmed));
      reportJsonDiagnostic(cell, trimmed, 'json-parsed', formatted);
      return formatted;
    } catch {
      reportJsonDiagnostic(cell, trimmed, 'json-parse-failed');
    }
  }
  const fragment = trimmed.match(/^"([^"\\]+)"\s*:\s*(.+?),?$/);
  if (fragment) {
    let value = fragment[2].trim();
    try {
      value = scalarText(JSON.parse(value.replace(/,$/, '')));
    } catch {
      value = value.replace(/,$/, '').replace(/^"|"$/g, '');
    }
    const formatted = `${fragment[1]}: ${value}`;
    reportJsonDiagnostic(cell, trimmed, 'json-fragment', formatted);
    return formatted;
  }
  return trimmed;
}

function readableOutputLines(cell, lines) {
  return compactLines((lines || []).map((line) => readableOutputLine(cell, line)).filter(Boolean));
}

function compactLines(lines) {
  return (lines || [])
    .map((line) => String(line || '').trimEnd())
    .filter((line) => line.trim())
    .slice(-PREVIEW_LINES);
}

function leadingLines(lines) {
  return (lines || [])
    .map((line) => String(line || '').trimEnd())
    .filter((line) => line.trim())
    .slice(0, PREVIEW_LINES);
}

function outputLines(cell) {
  if (cell.phase === 'started' || cell.phase === 'updated') {
    return readableOutputLines(cell, String(cell.liveOutput || '').split(/\r?\n/));
  }
  const payload = cell.payload || {};
  const preferred = cell.phase === 'failed'
    ? [...(payload.stdout_preview || []), ...(payload.stderr_preview || [])]
    : [...(payload.stderr_preview || []), ...(payload.stdout_preview || [])];
  return readableOutputLines(cell, preferred);
}

function commandPresentation(cell) {
  const payload = cell.payload || {};
  const command = payload.command || 'command';
  if (cell.phase === 'started' || cell.phase === 'updated') {
    return {
      status: 'active',
      title: `Running ${command}`,
      lines: outputLines(cell),
      detail: outputLines(cell).at(-1) || command,
    };
  }
  if (cell.phase === 'failed') {
    const terminalTitles = {
      canceled: 'Canceled',
      timed_out: 'Timed out',
      interrupted: 'Interrupted',
    };
    const terminalTitle = terminalTitles[payload.state];
    const exit = Number.isInteger(payload.exit_code) ? ` (exit ${payload.exit_code})` : '';
    const lines = outputLines(cell);
    if (!lines.length && payload.error_message) lines.push(payload.error_message);
    return {
      status: 'failed',
      title: terminalTitle ? `${terminalTitle} ${command}` : `Failed${exit} ${command}`,
      lines: compactLines(lines),
      detail: compactLines(lines).at(-1) || command,
    };
  }
  const lines = outputLines(cell);
  if (!lines.length) lines.push('(no output)');
  return {
    status: 'completed',
    title: `Ran ${command}`,
    lines,
    detail: lines.at(-1) || command,
  };
}

function explorationPresentation(cell) {
  if (cell.phase === 'failed') {
    const payload = cell.payload || {};
    return {
      status: 'failed',
      title: 'Failed to explore',
      lines: compactLines([payload.diagnostic || payload.error_code || 'Exploration failed']),
      detail: payload.diagnostic || payload.error_code || 'Exploration failed',
    };
  }
  const lines = (cell.entries || []).map((entry) => {
    const detail = entry.detail ? ` · ${entry.detail}` : '';
    return `${entry.verb} ${entry.label}${detail}`;
  });
  return {
    status: cell.phase === 'started' || cell.phase === 'updated' ? 'active' : 'completed',
    title: cell.phase === 'started' || cell.phase === 'updated' ? 'Exploring' : 'Explored',
    lines: compactLines(lines),
    detail: lines.at(-1) || 'Explored workspace',
  };
}

function fileStat(change) {
  const additions = Number(change?.additions || 0);
  const deletions = Number(change?.deletions || 0);
  return `(+${additions} -${deletions})`;
}

function patchPresentation(cell) {
  const payload = cell.payload || {};
  if (cell.phase === 'started' || cell.phase === 'updated') {
    return {
      status: 'active',
      title: payload.dry_run ? 'Checking patch' : 'Applying patch',
      lines: [],
      detail: payload.dry_run ? 'Checking patch' : 'Applying patch',
    };
  }
  if (cell.phase === 'failed') {
    return {
      status: 'failed',
      marker: '✘',
      title: 'Failed to apply patch',
      lines: compactLines([payload.diagnostic || payload.error_code || 'Patch failed']),
      detail: payload.diagnostic || payload.error_code || 'Patch failed',
    };
  }

  const changes = payload.changed_files || [];
  const additions = changes.reduce((sum, item) => sum + Number(item.additions || 0), 0);
  const deletions = changes.reduce((sum, item) => sum + Number(item.deletions || 0), 0);
  let title = `${payload.dry_run ? 'Checked' : 'Edited'} ${changes.length} files (+${additions} -${deletions})`;
  if (changes.length === 1) {
    const change = changes[0];
    const verb = payload.dry_run
      ? 'Checked'
      : change.operation === 'added'
        ? 'Added'
        : change.operation === 'deleted' ? 'Deleted' : 'Edited';
    title = `${verb} ${change.path} ${fileStat(change)}`;
  }
  return {
    status: 'completed',
    title,
    lines: leadingLines(changes.map((change) => `${change.path} ${fileStat(change)}`)),
    detail: payload.diff_stat || title,
  };
}

function writePresentation(cell) {
  const payload = cell.payload || {};
  if (cell.phase === 'started' || cell.phase === 'updated') {
    const title = `${payload.dry_run ? 'Checking' : 'Writing'} ${payload.path || 'file'}`;
    return { status: 'active', title, lines: [], detail: payload.path || 'file' };
  }
  if (cell.phase === 'failed') {
    return {
      status: 'failed',
      title: `Failed to write ${payload.path || 'file'}`,
      lines: compactLines([payload.diagnostic || payload.error_code || 'Write failed']),
      detail: payload.diagnostic || payload.error_code || 'Write failed',
    };
  }
  const verb = payload.dry_run || payload.operation === 'unchanged'
    ? 'Checked'
    : payload.operation === 'added' ? 'Created' : 'Wrote';
  const changes = payload.changed_files || [];
  return {
    status: 'completed',
    title: `${verb} ${payload.path || 'file'}`,
    lines: compactLines(changes.map((change) => `${change.path} ${fileStat(change)}`)),
    detail: payload.diff_stat || payload.path || 'file',
  };
}

function skillPresentation(cell) {
  const payload = cell.payload || {};
  const active = cell.phase === 'started' || cell.phase === 'updated';
  if (payload.operation === 'read') {
    const label = [payload.skill_id, payload.path].filter(Boolean).join(' / ');
    return {
      status: cell.phase === 'failed' ? 'failed' : active ? 'active' : 'completed',
      title: cell.phase === 'failed'
        ? `Failed to read skill ${label}`
        : active ? `Reading skill ${label}` : `Read skill ${label}`,
      lines: compactLines([cell.phase === 'failed' ? payload.diagnostic : payload.returned_lines]),
      detail: label,
    };
  }
  const ids = payload.skill_ids || [];
  const label = ids.join(', ') || 'skill';
  return {
    status: cell.phase === 'failed' ? 'failed' : active ? 'active' : 'completed',
    title: cell.phase === 'failed'
      ? `Failed to load skill ${label}`
      : active ? `Loading skill ${label}` : `Loaded skill ${label}`,
    lines: compactLines([cell.phase === 'failed' ? payload.diagnostic : '']),
    detail: label,
  };
}

function legacyPresentation(cell) {
  const summary = cell.payload?.summary || {};
  const action = summary.action;
  const detail = summary.detail || '';
  const titles = {
    prepareWorkspace: 'Prepared workspace',
    workspaceCommand: 'Ran command',
    workspaceInspect: 'Explored',
    workspaceSearch: 'Explored',
    workspaceReadFiles: 'Explored',
    workspaceApplyPatch: 'Edited files',
    workspaceWriteFile: 'Wrote file',
    loadSkills: 'Loaded skill',
    readSkillContent: 'Read skill',
    gptGetSectionLocator: 'Got section locator',
    gptGetExerciseLocator: 'Got exercise locator',
    gptListChapterExercises: 'Listed chapter exercises',
  };
  return {
    status: 'completed',
    title: titles[action] || 'Completed action',
    lines: compactLines([detail]),
    detail: detail || titles[action] || 'Completed action',
  };
}

function locatorPresentation(cell) {
  const payload = cell.payload || {};
  const active = cell.phase === 'started' || cell.phase === 'updated';
  const status = cell.phase === 'failed' ? 'failed' : active ? 'active' : 'completed';
  const pageLabel = payload.printed_page_start && payload.printed_page_end
    ? payload.printed_page_start === payload.printed_page_end
      ? `Page ${payload.printed_page_start}`
      : `Pages ${payload.printed_page_start}–${payload.printed_page_end}`
    : '';
  const referenceLabel = Number.isInteger(payload.reference_count)
    ? `${payload.reference_count} ${payload.reference_count === 1 ? 'reference' : 'references'}`
    : '';
  const definitions = {
    get_section_locator: {
      active: `Getting section locator ${payload.section_id || ''}`.trim(),
      completed: `Got section locator ${payload.section_id || ''}`.trim(),
      failed: `Failed to get section locator ${payload.section_id || ''}`.trim(),
      lines: [
        payload.title,
        pageLabel,
      ],
      detail: payload.section_id || 'section locator',
    },
    get_exercise_locator: {
      active: `Getting exercise locator ${payload.exercise_id || ''}`.trim(),
      completed: `Got exercise locator ${payload.exercise_id || ''}`.trim(),
      failed: `Failed to get exercise locator ${payload.exercise_id || ''}`.trim(),
      lines: [
        pageLabel,
        referenceLabel,
      ],
      detail: payload.exercise_id || 'exercise locator',
    },
    list_chapter_exercises: {
      active: `Listing chapter ${payload.chapter_id || ''} exercises`.trim(),
      completed: `Listed chapter ${payload.chapter_id || ''} exercises`.trim(),
      failed: `Failed to list chapter ${payload.chapter_id || ''} exercises`.trim(),
      lines: [
        Number.isInteger(payload.exercise_count) ? `${payload.exercise_count} exercises` : '',
        payload.first_exercise && payload.last_exercise
          ? `${payload.first_exercise}–${payload.last_exercise}`
          : '',
      ],
      detail: payload.chapter_id ? `chapter ${payload.chapter_id}` : 'chapter exercises',
    },
  };
  const definition = definitions[payload.operation];
  if (!definition) return null;
  const lines = [...definition.lines];
  if (cell.phase === 'failed') lines.push(payload.diagnostic || payload.error_code || 'Action failed');
  return {
    status,
    title: definition[status],
    lines: compactLines(lines),
    detail: definition.detail,
  };
}

function genericPresentation(cell) {
  const payload = cell.payload || {};
  const active = cell.phase === 'started' || cell.phase === 'updated';
  const locator = locatorPresentation(cell);
  if (locator) return locator;
  if (payload.operation === 'prepare_workspace') {
    const title = cell.phase === 'failed'
      ? 'Failed to prepare workspace'
      : active ? 'Preparing workspace' : 'Prepared workspace';
    return {
      status: cell.phase === 'failed' ? 'failed' : active ? 'active' : 'completed',
      title,
      lines: compactLines([payload.diagnostic || payload.workspace_id]),
      detail: payload.workspace_id || title,
    };
  }
  const status = cell.phase === 'failed' ? 'failed' : active ? 'active' : 'completed';
  const title = status === 'failed'
    ? 'Failed action'
    : status === 'active' ? 'Running action' : 'Completed action';
  const detail = payload.diagnostic
    || (status === 'failed' ? 'Action failed' : status === 'active' ? 'Action in progress' : 'Action completed');
  return {
    status,
    title,
    lines: compactLines([payload.diagnostic || '']),
    detail,
  };
}

export function presentActivity(cell) {
  if (!cell) return { status: 'completed', marker: '•', title: 'GPT Actions', lines: [], detail: '' };
  if (cell.kind === 'command') return commandPresentation(cell);
  if (cell.kind === 'exploration') return explorationPresentation(cell);
  if (cell.kind === 'patch') return patchPresentation(cell);
  if (cell.kind === 'write') return writePresentation(cell);
  if (cell.kind === 'skill') return skillPresentation(cell);
  if (cell.kind === 'legacy') return legacyPresentation(cell);
  return genericPresentation(cell);
}

export function compactActivity(cell) {
  const presentation = presentActivity(cell);
  return {
    action: presentation.title,
    detail: presentation.detail || presentation.lines.at(-1) || '',
    status: presentation.status,
  };
}
