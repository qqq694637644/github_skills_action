export function createHistoryPanel({ logBox, eventStore }) {
  function createEventNode(summary) {
    const node = document.createElement('div');
    node.className = 'gam-entry';
    node.title = summary.raw;

    const top = document.createElement('div');
    top.className = 'gam-entry-top';

    const time = document.createElement('span');
    time.className = 'gam-time';
    time.textContent = summary.time || '--:--';

    const action = document.createElement('span');
    action.className = 'gam-action';
    action.textContent = summary.action;

    const detail = document.createElement('div');
    detail.className = 'gam-detail';
    detail.textContent = summary.detail;

    top.append(time, action);
    node.append(top, detail);
    return node;
  }

  function createHintNode(message) {
    const node = document.createElement('div');
    node.className = 'gam-entry gam-hint';
    node.textContent = message;
    return node;
  }

  function appendEvent(summary) {
    logBox.appendChild(createEventNode(summary));
    logBox.scrollTop = logBox.scrollHeight;
  }

  function appendHint(message) {
    logBox.appendChild(createHintNode(message));
    logBox.scrollTop = logBox.scrollHeight;
  }

  function render() {
    const fragment = document.createDocumentFragment();
    for (const item of eventStore.all()) {
      fragment.appendChild(
        item.kind === 'event' ? createEventNode(item.summary) : createHintNode(item.message),
      );
    }
    logBox.replaceChildren(fragment);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function clear() {
    logBox.replaceChildren();
  }

  return { appendEvent, appendHint, render, clear };
}
