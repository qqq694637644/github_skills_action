import { presentActivity } from '../activity/presentation.js';

function createCellNode() {
  const node = document.createElement('div');
  node.className = 'gam-activity-cell';
  const title = document.createElement('div');
  title.className = 'gam-activity-title';
  const marker = document.createElement('span');
  marker.className = 'gam-activity-marker';
  const label = document.createElement('span');
  label.className = 'gam-activity-label';
  title.append(marker, label);
  const details = document.createElement('div');
  details.className = 'gam-activity-details';
  node.append(title, details);
  node._gam = { marker, label, details, signature: '' };
  return node;
}

function updateCellNode(node, cell) {
  const presentation = presentActivity(cell);
  const signature = JSON.stringify([
    cell.revision,
    cell.phase,
    presentation.status,
    presentation.marker,
    presentation.title,
    presentation.lines,
  ]);
  if (node._gam.signature === signature) return;
  node._gam.signature = signature;
  node.dataset.status = presentation.status;
  node.dataset.kind = cell.kind;
  node._gam.marker.textContent = presentation.marker || '•';
  node._gam.label.textContent = presentation.title;
  node.title = presentation.title;
  node._gam.details.replaceChildren();
  for (const line of presentation.lines) {
    const detail = document.createElement('div');
    detail.className = 'gam-activity-detail-line';
    detail.textContent = line;
    node._gam.details.appendChild(detail);
  }
}

function syncList(container, cells, nodes) {
  const liveIds = new Set(cells.map((cell) => cell.id));
  for (const [id, node] of nodes) {
    if (!liveIds.has(id)) {
      node.remove();
      nodes.delete(id);
    }
  }
  for (const cell of cells) {
    let node = nodes.get(cell.id);
    if (!node) {
      node = createCellNode();
      nodes.set(cell.id, node);
    }
    updateCellNode(node, cell);
    container.appendChild(node);
  }
}

export function createActivityPanel({ root }) {
  root.innerHTML = `
    <div class="gam-monitor-hint" hidden></div>
    <section class="gam-activity-section gam-now-section">
      <div class="gam-activity-section-label">NOW</div>
      <div class="gam-now-list"></div>
    </section>
    <section class="gam-activity-section gam-recent-section">
      <div class="gam-activity-section-label">RECENT</div>
      <div class="gam-recent-list"></div>
    </section>
  `;

  const hint = root.querySelector('.gam-monitor-hint');
  const nowSection = root.querySelector('.gam-now-section');
  const recentSection = root.querySelector('.gam-recent-section');
  const nowList = root.querySelector('.gam-now-list');
  const recentList = root.querySelector('.gam-recent-list');
  const nowNodes = new Map();
  const recentNodes = new Map();

  function render(snapshot) {
    const wasNearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 28;
    syncList(nowList, snapshot.active || [], nowNodes);
    syncList(recentList, snapshot.recent || [], recentNodes);
    nowSection.hidden = !(snapshot.active || []).length;
    recentSection.hidden = !(snapshot.recent || []).length;
    if (wasNearBottom) root.scrollTop = root.scrollHeight;
  }

  function setHint(message) {
    hint.textContent = message || '';
    hint.hidden = !message;
  }

  function clear() {
    nowNodes.clear();
    recentNodes.clear();
    nowList.replaceChildren();
    recentList.replaceChildren();
    nowSection.hidden = true;
    recentSection.hidden = true;
  }

  return { render, setHint, clear };
}
