import assert from 'node:assert/strict';
import { createActivityStore } from './src/activity/activity-store.js';
import {
  activityHoverText,
  explorationEntryHoverText,
  presentActivity,
} from './src/activity/presentation.js';
import { createActionLogClient } from './src/api/action-log-client.js';
import { createSkillCatalogClient } from './src/api/skill-catalog-client.js';
import { loadSkillsCall } from './src/adapters/composer.js';
import { createSoundAlert } from './src/alert/sound-alert.js';
import { selectNowCells } from './src/ui/activity-panel.js';
import {
  loadEndpoints,
  loadGlobalActiveEndpointId,
  loadPageBinding,
  loadPageBindings,
  saveEndpoints,
  saveGlobalActiveEndpointId,
  savePageBinding,
  validateBackend,
} from './src/profile/profile-store.js';
import { summarize } from './src/formatter/action-formatter.js';
import { installDomFixture } from './test/dom-fixture.mjs';

const succeeded = summarize(
  '[2026-09-21 12:00:00] ACTION workspaceCommand action="start" command="git status --short" state="succeeded" exit_code=0',
);
assert.equal(succeeded.action, 'workspaceCommand');
assert.equal(succeeded.detail, 'start · succeeded · git status --short');

const failed = summarize(
  '[2026-09-21 12:00:00] ACTION workspaceCommand action="start" command="pytest -q" state="failed" exit_code=1',
);
assert.equal(failed.detail, 'start · failed · exit 1 · pytest -q');

assert.deepEqual(validateBackend('https://skills.example.com/'), {
  ok: true,
  backend: 'https://skills.example.com',
});
assert.equal(validateBackend('ftp://skills.example.com').ok, false);
assert.equal(loadSkillsCall('github-maintenance'), 'loadSkills(["github-maintenance"])');

// Sound alerts only arm once the UI has a visible server-activity time, then
// fire once per quiet period and re-arm after a newer activity arrives.
{
  const { timers } = installDomFixture();
  const base = Date.parse('2026-10-04T10:00:00Z');
  let currentTime = base;
  let enabled = true;
  let armed = false;
  let delayMs = 3 * 60 * 1000;
  let durationMs = 5 * 1000;
  let plays = 0;
  const playedDurations = [];
  const alert = createSoundAlert({
    isEnabled: () => enabled,
    canArm: () => armed,
    getDelayMs: () => delayMs,
    getDurationMs: () => durationMs,
    now: () => currentTime,
    player: {
      unlock: async () => true,
      test: async (duration) => { playedDurations.push(duration); return true; },
      play: (duration) => { plays += 1; playedDurations.push(duration); return true; },
    },
  });

  assert.equal(alert.observe('2026-10-04T10:00:00Z'), false);
  assert.equal(timers.size, 0);
  armed = true;
  assert.equal(alert.observe('2026-10-04T10:00:00Z'), true);
  currentTime = base + 3 * 60 * 1000;
  const [firstTimerId, firstTimer] = timers.entries().next().value;
  timers.delete(firstTimerId);
  firstTimer();
  assert.equal(plays, 1);
  assert.equal(playedDurations.at(-1), 5000);
  alert.check();
  assert.equal(plays, 1);

  currentTime = base + 3 * 60 * 1000 + 1000;
  assert.equal(alert.observe('2026-10-04T10:03:01Z'), true);
  delayMs = 60 * 1000;
  durationMs = 9 * 1000;
  alert.settingsChanged();
  currentTime += 60 * 1000;
  const [secondTimerId, secondTimer] = timers.entries().next().value;
  timers.delete(secondTimerId);
  secondTimer();
  assert.equal(plays, 2);
  assert.equal(playedDurations.at(-1), 9000);
  assert.equal(await alert.test(), true);
  assert.equal(playedDurations.at(-1), 9000);

  enabled = false;
  alert.settingsChanged();
  assert.equal(timers.size, 0);
}

// V3 deliberately separates the persistent endpoint library from the global
// active endpoint and ignores the legacy combined profile storage key.
{
  const values = new Map([
    ['gptActionMonitorProfiles', {
      version: 2,
      endpoints: [{ id: 'legacy', name: 'legacy', backend: 'https://legacy.example.com', token: '' }],
      selectedEndpointId: 'legacy',
    }],
  ]);
  globalThis.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
  globalThis.GM_setValue = (key, value) => values.set(key, value);

  assert.deepEqual(loadEndpoints(), []);
  assert.equal(loadGlobalActiveEndpointId(), '');

  const endpoints = saveEndpoints([
    { id: 'alpha', name: 'Alpha', backend: 'https://alpha.example.com/', token: 'a' },
    { id: 'beta', name: 'Beta', backend: 'https://beta.example.com', token: 'b' },
  ]);
  assert.deepEqual(endpoints, [
    { id: 'alpha', name: 'Alpha', backend: 'https://alpha.example.com', token: 'a' },
    { id: 'beta', name: 'Beta', backend: 'https://beta.example.com', token: 'b' },
  ]);
  assert.equal(loadGlobalActiveEndpointId(), '');

  saveGlobalActiveEndpointId('beta');
  assert.equal(loadGlobalActiveEndpointId(), 'beta');
  assert.deepEqual(loadEndpoints(), endpoints);

  savePageBinding('https://chatgpt.com/c/alpha', {
    endpointId: 'alpha',
    workspaceId: 'ws_0123456789abcdef',
    workspaceEndpointId: 'alpha',
  }, 100);
  assert.deepEqual(loadPageBinding('https://chatgpt.com/c/alpha'), {
    url: 'https://chatgpt.com/c/alpha',
    endpointId: 'alpha',
    workspaceId: 'ws_0123456789abcdef',
    workspaceEndpointId: 'alpha',
    modifiedAt: 100,
  });
  savePageBinding('https://chatgpt.com/c/alpha', {
    endpointId: 'alpha',
    workspaceId: 'ws_0123456789abcdef',
    workspaceEndpointId: 'alpha',
  }, 150);
  assert.equal(loadPageBinding('https://chatgpt.com/c/alpha').modifiedAt, 100);

  for (let index = 0; index < 20; index += 1) {
    savePageBinding(`https://chatgpt.com/c/${index}`, {
      endpointId: index % 2 ? 'alpha' : 'beta',
      workspaceId: '',
      workspaceEndpointId: '',
    }, 200 + index);
  }
  const pageBindings = loadPageBindings();
  assert.equal(pageBindings.length, 20);
  assert.equal(pageBindings.some((binding) => binding.url === 'https://chatgpt.com/c/alpha'), false);
  assert.equal(pageBindings[0].url, 'https://chatgpt.com/c/19');

  savePageBinding('https://chatgpt.com/c/19', {
    endpointId: '',
    workspaceId: '',
    workspaceEndpointId: '',
  }, 999);
  assert.equal(loadPageBinding('https://chatgpt.com/c/19'), null);
}

// Skill catalog reads are cached in-page, while explicit refresh performs a
// new backend read so the server can rescan its on-disk Skill catalog.
{
  installDomFixture();
  let profile = { id: 'alpha-profile', backend: 'https://alpha.example.com', token: '' };
  let requests = 0;
  globalThis.GM_xmlhttpRequest = ({ url, onload }) => {
    requests += 1;
    const skillId = url.startsWith('https://beta.example.com')
      ? 'beta'
      : requests === 3 ? 'alpha-refreshed' : 'alpha';
    onload({
      status: 200,
      responseText: JSON.stringify({
        skills: [{
          skill_id: skillId,
          name: skillId,
          description: 'Demo skill.',
        }],
      }),
    });
    return { abort() {} };
  };
  const catalog = createSkillCatalogClient({
    getProfile: () => profile,
  });
  assert.equal((await catalog.list())[0].skill_id, 'alpha');
  assert.equal((await catalog.list())[0].skill_id, 'alpha');
  assert.equal(requests, 1);

  profile = { id: 'beta-profile', backend: 'https://beta.example.com', token: '' };
  assert.equal((await catalog.list())[0].skill_id, 'beta');
  assert.equal(requests, 2);

  profile = { id: 'alpha-profile', backend: 'https://alpha.example.com', token: '' };
  assert.equal((await catalog.list())[0].skill_id, 'alpha');
  assert.equal(requests, 2);
  assert.equal((await catalog.list({ refresh: true }))[0].skill_id, 'alpha-refreshed');
  assert.equal(requests, 3);
}

// Reopening/refreshing while the first catalog request is still in flight must
// reuse that request rather than issuing duplicate backend reads.
{
  installDomFixture();
  let requests = 0;
  let completeRequest = null;
  globalThis.GM_xmlhttpRequest = ({ onload }) => {
    requests += 1;
    completeRequest = () => onload({
      status: 200,
      responseText: JSON.stringify({ skills: [] }),
    });
    return { abort() {} };
  };
  const catalog = createSkillCatalogClient({
    getProfile: () => ({ id: 'alpha', backend: 'https://skills.example.com', token: '' }),
  });
  const first = catalog.list();
  const refresh = catalog.list({ refresh: true });
  assert.equal(requests, 1);
  completeRequest();
  await Promise.all([first, refresh]);
}

// Structured command events update one active cell in place and move it to
// recent history only when the command becomes terminal.
{
  const activityStore = createActivityStore();
  activityStore.ingest([{
    id: 1,
    event: {
      activity_id: 'command:op_1',
      kind: 'command',
      phase: 'started',
      timestamp: '2026-09-21T12:00:00Z',
      payload: { command: 'python -m pytest -q', state: 'running' },
    },
  }]);
  assert.equal(activityStore.snapshot().active.length, 1);
  assert.equal(activityStore.snapshot().recent.length, 0);

  activityStore.ingest([{
    id: 2,
    event: {
      activity_id: 'command:op_1',
      kind: 'command',
      phase: 'updated',
      timestamp: '2026-09-21T12:00:01Z',
      payload: { stream: 'stdout', delta: 'one\ntwo\nthree\nfour\n' },
    },
  }]);
  const running = activityStore.snapshot().active[0];
  const runningPresentation = presentActivity(running);
  assert.equal(runningPresentation.title, 'Running python -m pytest -q');
  assert.deepEqual(runningPresentation.lines, ['two', 'three', 'four']);
  const runningHover = activityHoverText(running);
  assert.match(runningHover, /^\d{2}:\d{2}:\d{2} · python -m pytest -q\none\ntwo\nthree\nfour$/);

  activityStore.ingest([{
    id: 3,
    event: {
      activity_id: 'command:op_1',
      kind: 'command',
      phase: 'completed',
      timestamp: '2026-09-21T12:00:02Z',
      payload: {
        command: 'python -m pytest -q',
        state: 'succeeded',
        exit_code: 0,
        stdout_preview: ['49 passed in 3.8s'],
        stderr_preview: [],
      },
    },
  }]);
  assert.equal(activityStore.snapshot().active.length, 0);
  assert.equal(activityStore.snapshot().recent.length, 1);
  const completedCommand = activityStore.snapshot().recent[0];
  assert.equal(presentActivity(completedCommand).title, 'Ran python -m pytest -q');
  assert.match(activityHoverText(completedCommand), /^\d{2}:\d{2}:\d{2} · python -m pytest -q\none\ntwo\nthree\nfour$/);

  activityStore.ingest([{
    id: 3,
    event: {
      activity_id: 'command:op_1',
      kind: 'command',
      phase: 'completed',
      timestamp: '2026-09-21T12:00:02Z',
      payload: { command: 'python -m pytest -q' },
    },
  }]);
  assert.equal(activityStore.snapshot().recent.length, 1);
}

// Failed commands follow Codex naming and prioritize bounded failure output.
{
  const activityStore = createActivityStore();
  activityStore.ingest([{
    id: 10,
    event: {
      activity_id: 'command:op_failed',
      kind: 'command',
      phase: 'failed',
      payload: {
        command: 'pytest -q',
        exit_code: 1,
        stderr_preview: ['AssertionError: expected value', '1 failed, 48 passed'],
        stdout_preview: [],
      },
    },
  }]);
  const presentation = presentActivity(activityStore.snapshot().recent[0]);
  assert.equal(presentation.title, 'Failed (exit 1) pytest -q');
  assert.deepEqual(presentation.lines, ['AssertionError: expected value', '1 failed, 48 passed']);
}

// Target-specific GPT Action endpoints can publish generic structured events;
// render their operation payloads as human activity instead of "Completed action".
{
  const cases = [
    {
      payload: {
        operation: 'get_section_locator',
        section_id: '2.6.5',
        title: 'Spatial Operations',
        printed_page_start: '105',
        printed_page_end: '105',
      },
      title: 'Got section locator 2.6.5',
      lines: ['Spatial Operations', 'Page 105'],
    },
    {
      payload: {
        operation: 'get_exercise_locator',
        exercise_id: '2.14',
        printed_page_start: '141',
        printed_page_end: '141',
        reference_count: 1,
      },
      title: 'Got exercise locator 2.14',
      lines: ['Page 141', '1 reference'],
    },
    {
      payload: {
        operation: 'list_chapter_exercises',
        chapter_id: '2',
        exercise_count: 2,
        first_exercise: '2.14',
        last_exercise: '2.15',
      },
      title: 'Listed chapter 2 exercises',
      lines: ['2 exercises', '2.14–2.15'],
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const presentation = presentActivity({
      id: `locator:${index}`,
      kind: 'generic',
      phase: 'completed',
      payload: testCase.payload,
      revision: 1,
    });
    assert.equal(presentation.title, testCase.title);
    assert.deepEqual(presentation.lines, testCase.lines);
  }

  const running = presentActivity({
    id: 'locator:running',
    kind: 'generic',
    phase: 'started',
    payload: { operation: 'get_section_locator', section_id: '3.1.5' },
    revision: 1,
  });
  assert.equal(running.status, 'active');
  assert.equal(running.title, 'Getting section locator 3.1.5');

  const failedLocator = presentActivity({
    id: 'locator:failed',
    kind: 'generic',
    phase: 'failed',
    payload: {
      operation: 'get_section_locator',
      section_id: '2.6.99',
      error_code: 'SECTION_NOT_FOUND',
      diagnostic: 'Section not found',
    },
    revision: 1,
  });
  assert.equal(failedLocator.status, 'failed');
  assert.equal(failedLocator.title, 'Failed to get section locator 2.6.99');
  assert.deepEqual(failedLocator.lines, ['Section not found']);

  const unknownRunning = presentActivity({
    id: 'generic:running',
    kind: 'future-kind',
    phase: 'updated',
    payload: { operation: 'future_operation' },
    revision: 1,
  });
  assert.equal(unknownRunning.status, 'active');
  assert.equal(unknownRunning.title, 'Running action');
  assert.equal(unknownRunning.detail, 'Action in progress');

  const preparingWorkspace = presentActivity({
    id: 'generic:workspace',
    kind: 'future-kind',
    phase: 'started',
    payload: { operation: 'prepare_workspace' },
    revision: 1,
  });
  assert.equal(preparingWorkspace.status, 'active');
  assert.equal(preparingWorkspace.title, 'Preparing workspace');
}

// Exploration remains compact, but a rendered Explored group is capped at the
// three visible rows. New exploration spills into a new history cell instead
// of replacing information that was already shown to the user.
{
  const activityStore = createActivityStore();
  activityStore.ingest([{
    id: 19,
    event: {
      activity_id: 'search:active',
      kind: 'exploration',
      phase: 'started',
      payload: { operation: 'search', query: 'workspaceCommand', paths: ['src'] },
    },
  }]);
  assert.equal(activityStore.snapshot().active.length, 1);
  assert.equal(presentActivity(activityStore.snapshot().active[0]).title, 'Exploring');
  activityStore.ingest([{
    id: 20,
    event: {
      activity_id: 'search:active',
      kind: 'exploration',
      phase: 'completed',
      timestamp: '2026-09-21T12:00:20Z',
      payload: { operation: 'search', query: 'workspaceCommand', match_count: 11 },
    },
  }]);
  assert.equal(activityStore.snapshot().active.length, 0);
  assert.equal(activityStore.snapshot().recent.length, 1);

  activityStore.ingest([
    {
      id: 21,
      event: {
        activity_id: 'search:1',
        kind: 'exploration',
        phase: 'completed',
        timestamp: '2026-09-21T12:00:21Z',
        payload: { operation: 'search', query: 'workspaceCommand', match_count: 11 },
      },
    },
    {
      id: 22,
      event: {
        activity_id: 'read:1',
        kind: 'exploration',
        phase: 'completed',
        timestamp: '2026-09-21T12:00:22Z',
        payload: {
          operation: 'read',
          files: [
            { path: 'workspace_actions.py', start_line: 1, end_line: 200 },
            { path: 'runtime.py', start_line: 201, end_line: 244 },
          ],
        },
      },
    },
  ]);
  const explorationHistory = activityStore.snapshot().recent;
  assert.equal(explorationHistory.length, 2);
  assert.deepEqual(explorationHistory.map((cell) => cell.entries.length), [1, 3]);
  assert.equal(explorationHistory.every((cell) => presentActivity(cell).lines.length <= 3), true);
  assert.equal(presentActivity(explorationHistory[0]).title, 'Explored');
  assert.deepEqual(
    explorationHistory.flatMap((cell) => presentActivity(cell).lines).filter((line) => line.startsWith('Read ')),
    [
      'Read runtime.py · 201–244',
      'Read workspace_actions.py · 1–200',
    ],
  );
  assert.deepEqual(
    explorationHistory.flatMap((cell) => cell.entries).map((entry) => `${entry.verb} ${entry.label}`),
    [
      'Read runtime.py',
      'Search workspaceCommand',
      'Search workspaceCommand',
      'Read workspace_actions.py',
    ],
  );
  const searchEntry = explorationHistory[1].entries[1];
  assert.match(explorationEntryHoverText(searchEntry), /^\d{2}:\d{2}:\d{2} · Search workspaceCommand\n11 matches$/);

  activityStore.ingest([{
    id: 23,
    event: {
      activity_id: 'skill:1',
      kind: 'skill',
      phase: 'completed',
      payload: { operation: 'load', skill_ids: ['github-maintenance'] },
    },
  }]);
  activityStore.ingest([{
    id: 24,
    event: {
      activity_id: 'search:2',
      kind: 'exploration',
      phase: 'completed',
      payload: { operation: 'search', query: 'activity_id', match_count: 4 },
    },
  }]);
  assert.equal(activityStore.snapshot().recent.length, 4);
}

// Patch summaries match the Codex-style aggregate and keep only the first
// three file detail lines in the compact view.
{
  const activityStore = createActivityStore();
  activityStore.ingest([{
    id: 30,
    event: {
      activity_id: 'patch:1',
      kind: 'patch',
      phase: 'completed',
      payload: {
        changed_files: [
          { path: 'a.py', operation: 'modified', additions: 4, deletions: 1 },
          { path: 'b.py', operation: 'modified', additions: 2, deletions: 0 },
          { path: 'c.py', operation: 'added', additions: 5, deletions: 0 },
          { path: 'd.py', operation: 'deleted', additions: 0, deletions: 3 },
        ],
      },
    },
  }]);
  const presentation = presentActivity(activityStore.snapshot().recent[0]);
  assert.equal(presentation.title, 'Edited 4 files (+11 -4)');
  assert.deepEqual(presentation.lines, ['a.py (+4 -1)', 'b.py (+2 -0)', 'c.py (+5 -0)']);
}

// Completed activity history is bounded to 100 cells and dedicated renderers
// do not expose raw Action API names.
{
  const activityStore = createActivityStore();
  const items = [];
  for (let index = 0; index < 101; index += 1) {
    items.push({
      id: 100 + index,
      event: {
        activity_id: `skill:${index}`,
        kind: 'skill',
        phase: 'completed',
        payload: { operation: 'load', skill_ids: [`skill-${index}`] },
      },
    });
  }
  activityStore.ingest(items);
  assert.equal(activityStore.snapshot().recent.length, 100);
  assert.equal(presentActivity(activityStore.snapshot().recent[0]).title, 'Loaded skill skill-100');
  assert.equal(presentActivity(activityStore.snapshot().recent.at(-1)).title, 'Loaded skill skill-1');

  const legacy = createActivityStore();
  legacy.ingest([{
    id: 500,
    text: '[2026-09-21 12:00] ACTION workspaceCommand action="start" command="git status" state="succeeded"',
  }]);
  const title = presentActivity(legacy.snapshot().recent[0]).title;
  assert.equal(title, 'Ran command');
  assert.equal(title.includes('workspaceCommand'), false);
}

// Active and completed activity are newest-first so the current work remains
// at the front of the inspector rather than forcing the user to chase the
// bottom of a growing transcript.
{
  const activityStore = createActivityStore();
  activityStore.ingest([
    {
      id: 600,
      event: {
        activity_id: 'command:older',
        kind: 'command',
        phase: 'started',
        timestamp: '2026-09-21T12:00:00Z',
        payload: { command: 'older' },
      },
    },
    {
      id: 601,
      event: {
        activity_id: 'command:newer',
        kind: 'command',
        phase: 'started',
        timestamp: '2026-09-21T12:00:01Z',
        payload: { command: 'newer' },
      },
    },
  ]);
  assert.deepEqual(activityStore.snapshot().active.map((cell) => cell.id), [
    'command:newer',
    'command:older',
  ]);

  activityStore.ingest([
    {
      id: 602,
      event: {
        activity_id: 'command:older',
        kind: 'command',
        phase: 'completed',
        timestamp: '2026-09-21T12:00:02Z',
        payload: { command: 'older', stdout_preview: ['older done'] },
      },
    },
    {
      id: 603,
      event: {
        activity_id: 'command:newer',
        kind: 'command',
        phase: 'completed',
        timestamp: '2026-09-21T12:00:03Z',
        payload: { command: 'newer', stdout_preview: ['newer done'] },
      },
    },
  ]);
  assert.deepEqual(activityStore.snapshot().recent.map((cell) => cell.id), [
    'command:newer',
    'command:older',
  ]);
}

// NOW is a small live area, not a second scrollable history. Keep only the
// three most recently updated active cells and summarize the rest in the UI.
{
  const active = [
    { id: 'a', updatedAt: '2026-10-04T10:00:01Z' },
    { id: 'b', updatedAt: '2026-10-04T10:00:05Z' },
    { id: 'c', updatedAt: '2026-10-04T10:00:03Z' },
    { id: 'd', updatedAt: '2026-10-04T10:00:04Z' },
    { id: 'e', updatedAt: '2026-10-04T10:00:02Z' },
  ];
  assert.deepEqual(selectNowCells(active).map((cell) => cell.id), ['b', 'd', 'c']);
}

// Command JSON is presentation data, not an Action protocol failure. Render
// complete JSON and common pretty-printed key/value fragments readably, and
// emit bounded console diagnostics when JSON-like output is encountered so a
// real browser sample can be supplied if an unfamiliar shape still looks bad.
{
  const diagnostics = [];
  const originalDebug = console.debug;
  console.debug = (...args) => diagnostics.push(args);
  try {
    const cell = {
      id: 'command:json',
      kind: 'command',
      phase: 'completed',
      payload: {
        command: 'gh pr view --json state,baseRefName,headRefName',
        stdout_preview: [
          '{"state":"OPEN","baseRefName":"main","headRefName":"feature","headRefOid":"abc"}',
          '"esbuild": "^0.28.2",',
          '}',
        ],
        stderr_preview: [],
      },
      liveOutput: '',
      entries: [],
      revision: 1,
    };
    const presentation = presentActivity(cell);
    assert.deepEqual(presentation.lines, [
      'state: OPEN · baseRefName: main · headRefName: feature · …',
      'esbuild: ^0.28.2',
    ]);
    assert.equal(diagnostics.some(([label, detail]) => (
      label === '[GPT Action Monitor][Activity JSON]'
      && detail.outcome === 'json-parsed'
    )), true);
    assert.equal(diagnostics.some(([label, detail]) => (
      label === '[GPT Action Monitor][Activity JSON]'
      && detail.outcome === 'json-fragment'
    )), true);
  } finally {
    console.debug = originalDebug;
  }
}

// Poll suspension must abort the active request and resume with a fresh poll
// rather than leaving the old long-poll lifecycle running in the background.
{
  const { timers } = installDomFixture();
  let requests = 0;
  let aborts = 0;
  globalThis.GM_xmlhttpRequest = () => {
    requests += 1;
    return {
      abort() {
        aborts += 1;
      },
    };
  };
  const client = createActionLogClient({
    getProfile: () => ({ backend: 'https://skills.example.com', token: '' }),
    getWorkspaceId: () => 'ws_0123456789abcdef',
    onItems: () => {},
    onHint: () => {},
  });
  client.start();
  const [timerId, runPoll] = timers.entries().next().value;
  timers.delete(timerId);
  runPoll();
  assert.equal(requests, 1);
  client.suspend();
  assert.equal(aborts, 1);
  assert.equal(timers.size, 0);
  client.resume();
  assert.equal(timers.size, 1);
  client.stop();
}

// Sound alerts keep the one selected-workspace long-poll alive while the page
// is hidden so inactivity can be measured without adding another request loop.
{
  const { document, timers } = installDomFixture();
  document.visibilityState = 'hidden';
  let requests = 0;
  globalThis.GM_xmlhttpRequest = () => {
    requests += 1;
    return { abort() {} };
  };
  const client = createActionLogClient({
    getProfile: () => ({ backend: 'https://skills.example.com', token: '' }),
    getWorkspaceId: () => 'ws_0123456789abcdef',
    onItems: () => {},
    onHint: () => {},
    shouldPollWhenHidden: () => true,
  });
  client.start();
  const [timerId, runPoll] = timers.entries().next().value;
  timers.delete(timerId);
  runPoll();
  assert.equal(requests, 1);
  client.stop();
}

// Recreating the poll client for the same page-session/profile can resume from
// its last cursor, so temporary ChatGPT title DOM churn does not discard
// activity events that arrive while the monitor is briefly deactivated.
{
  const { timers } = installDomFixture();
  const requestedUrls = [];
  globalThis.GM_xmlhttpRequest = ({ url, onload }) => {
    requestedUrls.push(url);
    onload({ status: 200, responseText: JSON.stringify({ items: [], last_id: 41 }) });
    return { abort() {} };
  };
  const client = createActionLogClient({
    getProfile: () => ({ backend: 'https://skills.example.com', token: '' }),
    getWorkspaceId: () => 'ws_0123456789abcdef',
    onItems: () => {},
    onHint: () => {},
    initialCursor: 40,
  });
  client.start();
  const [timerId, runPoll] = timers.entries().next().value;
  timers.delete(timerId);
  runPoll();
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0].includes('workspace_id=ws_0123456789abcdef'), true);
  assert.equal(requestedUrls[0].includes('after=40'), true);
  assert.equal(requestedUrls[0].includes('wait=55'), true);
  assert.equal(client.getCursor(), 41);
  client.stop();
}

// Without a selected Workspace, the client enters discovery mode and asks the
// server only for completed prepare_workspace events.
{
  const { timers } = installDomFixture();
  const requestedUrls = [];
  const received = [];
  globalThis.GM_xmlhttpRequest = ({ url, onload }) => {
    requestedUrls.push(url);
    onload({
      status: 200,
      responseText: JSON.stringify({
        last_id: 52,
        items: [
          {
            id: 51,
            event: {
              phase: 'completed',
              payload: { operation: 'prepare_workspace', workspace_id: 'ws_0123456789abcdef' },
            },
          },
          {
            id: 52,
            event: {
              phase: 'completed',
              payload: { operation: 'read' },
            },
          },
        ],
      }),
    });
    return { abort() {} };
  };
  const client = createActionLogClient({
    getProfile: () => ({ backend: 'https://skills.example.com', token: '' }),
    getWorkspaceId: () => null,
    onItems: (items) => received.push(...items),
    onHint: () => {},
    initialCursor: 50,
  });
  client.start();
  const [timerId, runPoll] = timers.entries().next().value;
  timers.delete(timerId);
  runPoll();
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0].includes('operation=prepare_workspace'), true);
  assert.equal(requestedUrls[0].includes('phase=completed'), true);
  assert.equal(requestedUrls[0].includes('workspace_id='), false);
  assert.deepEqual(received.map((item) => item.id), [51]);
  client.stop();
}
