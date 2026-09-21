import assert from 'node:assert/strict';
import { createActivityStore } from './src/activity/activity-store.js';
import { presentActivity } from './src/activity/presentation.js';
import { createActionLogClient } from './src/api/action-log-client.js';
import { createSkillCatalogClient } from './src/api/skill-catalog-client.js';
import { createChatGPTAdapter } from './src/adapters/chatgpt.js';
import { createComposerAdapter, loadSkillsCall } from './src/adapters/composer.js';
import { summarize } from './src/formatter/action-formatter.js';
import { validateBackend } from './src/profile/profile-store.js';
import { createActivityPanel } from './src/ui/activity-panel.js';
import { createMonitorPanel } from './src/ui/monitor-panel.js';
import { MONITOR_CSS } from './src/ui/styles.js';
import {
  FakeElement,
  FakeMutationObserver,
  installDomFixture,
} from './test/dom-fixture.mjs';

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
assert.match(MONITOR_CSS, /resize:\s*both/);
assert.match(MONITOR_CSS, /\.gam-resize-handle\s*\{[\s\S]*?left:\s*0;[\s\S]*?bottom:\s*0;[\s\S]*?cursor:\s*nesw-resize/);
assert.match(MONITOR_CSS, /\.gam-recent-section\s*\{[\s\S]*?overflow-y:\s*auto/);

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

// Composer selection is captured only when the Skills menu is opened and is
// restored for insertion; there is no persistent selection listener.
{
  const { document, window } = installDomFixture();
  const editor = new FakeElement('div');
  const range = {
    commonAncestorContainer: editor,
    cloneRange() { return this; },
  };
  let restoredRange = null;
  let insertedText = null;
  const selection = {
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange(value) { restoredRange = value; },
  };
  editor.contains = (node) => node === editor;
  document.querySelector = (selector) => (
    selector.includes('contenteditable="true"') ? editor : null
  );
  document.execCommand = (command, _showUi, value) => {
    assert.equal(command, 'insertText');
    insertedText = value;
    return true;
  };
  window.getSelection = () => selection;

  const composer = createComposerAdapter();
  assert.equal(composer.captureSelection(), true);
  assert.equal(composer.insertText(loadSkillsCall('github-maintenance')), true);
  assert.equal(restoredRange, range);
  assert.equal(insertedText, 'loadSkills(["github-maintenance"])');
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
  assert.equal(presentActivity(activityStore.snapshot().recent[0]).title, 'Ran python -m pytest -q');

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
}

// Consecutive inspect/search/read activity is coalesced into one Codex-style
// Explored history cell; a non-exploration cell breaks the group.
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
        payload: { operation: 'search', query: 'workspaceCommand', match_count: 11 },
      },
    },
    {
      id: 22,
      event: {
        activity_id: 'read:1',
        kind: 'exploration',
        phase: 'completed',
        payload: { operation: 'read', paths: ['workspace_actions.py', 'runtime.py'] },
      },
    },
  ]);
  assert.equal(activityStore.snapshot().recent.length, 1);
  assert.equal(activityStore.snapshot().recent[0].entries.length, 4);
  assert.equal(presentActivity(activityStore.snapshot().recent[0]).title, 'Explored');

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
  assert.equal(activityStore.snapshot().recent.length, 3);
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

// NOW cells update in place and terminal cells move into RECENT without
// duplicating DOM nodes.
{
  installDomFixture();
  const root = new FakeElement('div');
  const panel = createActivityPanel({ root });
  const running = {
    id: 'command:dom',
    kind: 'command',
    phase: 'started',
    payload: { command: 'pytest -q' },
    liveOutput: '',
    entries: [],
    revision: 1,
  };
  panel.render({ active: [running], recent: [] });
  const nowList = root.querySelector('.gam-now-list');
  const recentList = root.querySelector('.gam-recent-list');
  assert.equal(nowList.childElementCount, 1);
  assert.equal(recentList.childElementCount, 0);
  assert.equal(nowList.children[0].children[0].children[1].textContent, 'Running pytest -q');

  const updated = { ...running, liveOutput: 'collecting...\n', revision: 2 };
  panel.render({ active: [updated], recent: [] });
  assert.equal(nowList.childElementCount, 1);
  assert.equal(nowList.children[0].children[1].children[0].textContent, 'collecting...');

  const completed = {
    ...updated,
    phase: 'completed',
    payload: { command: 'pytest -q', stdout_preview: ['50 passed'], stderr_preview: [] },
    revision: 3,
  };
  panel.render({ active: [], recent: [completed] });
  assert.equal(nowList.childElementCount, 0);
  assert.equal(recentList.childElementCount, 1);
  assert.equal(recentList.children[0].children[0].children[1].textContent, 'Ran pytest -q');
}

// Keep the currently active GPT title/profile pinned while its original title
// element remains connected and still matches that profile.
{
  const { document } = installDomFixture();
  const selector = 'div[type="button"][aria-haspopup="menu"]';
  const profileA = { id: 'a', gptName: 'Alpha', enabled: true };
  const profileB = { id: 'b', gptName: 'Beta', enabled: true };
  const titleA = new FakeElement('div');
  titleA._matches = true;
  titleA.textContent = 'Alpha';
  titleA.isConnected = true;
  const titleB = new FakeElement('div');
  titleB._matches = true;
  titleB.textContent = 'Beta';
  titleB.isConnected = true;
  document.setQueryResults(selector, [titleA]);

  const activations = [];
  const adapter = createChatGPTAdapter({
    getProfiles: () => [profileA, profileB],
    onActivate: (_element, profile) => activations.push(profile.id),
    onDeactivate: () => activations.push('deactivated'),
  });
  adapter.start();
  assert.deepEqual(activations, ['a']);

  document.setQueryResults(selector, [titleA, titleB]);
  FakeMutationObserver.latest.trigger([{ target: document.body, addedNodes: [titleB] }]);
  assert.deepEqual(activations, ['a']);

  titleA.isConnected = false;
  document.setQueryResults(selector, [titleB]);
  FakeMutationObserver.latest.trigger([{ target: document.body, addedNodes: [titleB] }]);
  assert.deepEqual(activations, ['a', 'b']);
  adapter.stop();
}

// GPT title metadata such as a model/version badge must not become part of the
// configured GPT name. ChatGPT currently renders it as a child element next to
// the title's direct text node (for example: github_skill <span>5.5</span>).
{
  const { document } = installDomFixture();
  const selector = 'div[type="button"][aria-haspopup="menu"]';
  const profile = { id: 'github', gptName: 'github_skill', enabled: true };
  const title = new FakeElement('div');
  title._matches = true;
  title.textContent = 'github_skill5.5';
  title.childNodes = [
    { nodeType: Node.TEXT_NODE, textContent: 'github_skill' },
    { nodeType: Node.ELEMENT_NODE, textContent: '5.5' },
  ];
  title.isConnected = true;
  document.setQueryResults(selector, [title]);

  const activations = [];
  const adapter = createChatGPTAdapter({
    getProfiles: () => [profile],
    onActivate: (_element, matchedProfile) => activations.push(matchedProfile.id),
    onDeactivate: () => activations.push('deactivated'),
  });
  adapter.start();
  assert.deepEqual(activations, ['github']);
  FakeMutationObserver.latest.trigger([{ target: title, addedNodes: [] }]);
  assert.deepEqual(activations, ['github']);
  adapter.stop();
}

// Deactivation/unmount must discard activity queued by the previous profile so
// a later visibility resume cannot replay stale UI from that profile.
{
  const { document, timers } = installDomFixture();
  document.visibilityState = 'hidden';
  const panel = createMonitorPanel({
    activityStore: createActivityStore(),
    isActive: () => true,
  });
  panel.queueActivity({ action: 'profile-a', detail: 'old', time: '', raw: '' });
  assert.equal(timers.size, 0);
  panel.unmount();

  document.visibilityState = 'visible';
  panel.resumeActivity();
  assert.equal(timers.size, 0);
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
    onItems: () => {},
    onHint: () => {},
    initialCursor: 40,
  });
  client.start();
  const [timerId, runPoll] = timers.entries().next().value;
  timers.delete(timerId);
  runPoll();
  assert.equal(requestedUrls.length, 1);
  assert.equal(requestedUrls[0].includes('after=40'), true);
  assert.equal(requestedUrls[0].includes('wait=55'), true);
  assert.equal(client.getCursor(), 41);
  client.stop();
}
