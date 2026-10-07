const PREFIX = '[GPT Action Monitor]';

export function debugLog(scope, event, details = undefined) {
  if (details === undefined) console.log(`${PREFIX}[${scope}] ${event}`);
  else console.log(`${PREFIX}[${scope}] ${event}`, details);
}

export function debugWarn(scope, event, details = undefined) {
  if (details === undefined) console.warn(`${PREFIX}[${scope}] ${event}`);
  else console.warn(`${PREFIX}[${scope}] ${event}`, details);
}

export function debugError(scope, event, details = undefined) {
  if (details === undefined) console.error(`${PREFIX}[${scope}] ${event}`);
  else console.error(`${PREFIX}[${scope}] ${event}`, details);
}

export function summarizeActionItems(items) {
  return (items || []).slice(0, 20).map((item) => ({
    id: item?.id ?? null,
    activityId: item?.event?.activity_id ?? null,
    kind: item?.event?.kind ?? null,
    phase: item?.event?.phase ?? null,
    workspaceId: item?.event?.workspace_id ?? null,
    operation: item?.event?.payload?.operation ?? null,
  }));
}
