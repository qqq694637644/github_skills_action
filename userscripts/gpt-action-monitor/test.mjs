import assert from 'node:assert/strict';
import { summarize } from './src/formatter/action-formatter.js';
import { validateBackend } from './src/profile/profile-store.js';
import { createEventStore } from './src/store/event-store.js';

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

const store = createEventStore();
for (let index = 0; index < 101; index += 1) {
  store.add({ action: `action-${index}`, detail: 'ok', time: '', raw: '' });
}
assert.equal(store.all().length, 100);
assert.equal(store.all()[0].summary.action, 'action-1');
store.addHint('retrying');
assert.equal(store.all().at(-1).kind, 'hint');
store.clear();
assert.deepEqual(store.all(), []);
