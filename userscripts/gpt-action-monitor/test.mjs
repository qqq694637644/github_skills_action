import assert from 'node:assert/strict';
import { createActionLogClient } from './src/api/action-log-client.js';
import { createSkillCatalogClient } from './src/api/skill-catalog-client.js';
import { createChatGPTAdapter } from './src/adapters/chatgpt.js';
import { createComposerAdapter, loadSkillsCall } from './src/adapters/composer.js';
import { summarize } from './src/formatter/action-formatter.js';
import { validateBackend } from './src/profile/profile-store.js';
import { createEventStore } from './src/store/event-store.js';
import { createHistoryPanel } from './src/ui/history-panel.js';
import { createMonitorPanel } from './src/ui/monitor-panel.js';
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

const store = createEventStore();
for (let index = 0; index < 101; index += 1) {
  store.add({ action: `action-${index}`, detail: 'ok', time: '', raw: '' });
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
assert.equal(store.all().length, 100);
assert.equal(store.all()[0].summary.action, 'action-1');
store.addHint('retrying');
assert.equal(store.all().at(-1).kind, 'hint');
store.clear();
assert.deepEqual(store.all(), []);

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
    eventStore: createEventStore(),
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

// The expanded DOM history must stay bounded with the event store while new
// entries are appended, not only after close/reopen re-rendering.
{
  installDomFixture();
  const eventStore = createEventStore();
  const logBox = new FakeElement('div');
  const historyPanel = createHistoryPanel({ logBox, eventStore });
  for (let index = 0; index < 101; index += 1) {
    const summary = { action: `action-${index}`, detail: 'ok', time: '', raw: '' };
    eventStore.add(summary);
    historyPanel.appendEvent(summary);
  }
  assert.equal(eventStore.all().length, 100);
  assert.equal(logBox.childElementCount, 100);
}
