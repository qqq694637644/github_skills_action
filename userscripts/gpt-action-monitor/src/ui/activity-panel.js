import {
  activityHoverText,
  explorationEntryHoverText,
  presentActivity,
} from '../activity/presentation.js';

const LATEST_SCROLL_THRESHOLD_PX = 2;

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
  node._gam = { title, marker, label, details, signature: '' };
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
  node.dataset.activityId = cell.id;
  node.dataset.status = presentation.status;
  node.dataset.kind = cell.kind;
  node._gam.marker.textContent = presentation.marker || '•';
  node._gam.label.textContent = presentation.title;
  node.title = '';
  node._gam.title.title = cell.kind === 'exploration' ? '' : activityHoverText(cell);
  node._gam.details.replaceChildren();
  const visibleExplorationEntries = cell.kind === 'exploration'
    ? (cell.entries || []).slice(-presentation.lines.length)
    : [];
  const preparedWorkspaceId = cell.kind === 'generic'
    && cell.phase === 'completed'
    && cell.payload?.operation === 'prepare_workspace'
    && /^ws_[0-9a-f]{16}$/.test(cell.payload?.workspace_id || '')
      ? cell.payload.workspace_id
      : '';
  for (let index = 0; index < presentation.lines.length; index += 1) {
    const line = presentation.lines[index];
    const detail = document.createElement(preparedWorkspaceId ? 'button' : 'div');
    detail.className = 'gam-activity-detail-line';
    if (preparedWorkspaceId) {
      detail.type = 'button';
      detail.classList.add('gam-workspace-activity-link');
      detail.dataset.workspaceId = preparedWorkspaceId;
      detail.title = `${activityHoverText(cell)}\n点击切换到 ${preparedWorkspaceId}`;
    }
    detail.textContent = line;
    if (!preparedWorkspaceId) {
      detail.title = cell.kind === 'exploration'
        ? explorationEntryHoverText(visibleExplorationEntries[index])
        : activityHoverText(cell);
    }
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

export function createActivityPanel({ root, onSelectWorkspace = null }) {
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

  root.addEventListener('click', (event) => {
    const target = event.target.closest?.('.gam-workspace-activity-link');
    if (!target) return;
    const workspaceId = target.dataset.workspaceId || '';
    if (!/^ws_[0-9a-f]{16}$/.test(workspaceId)) return;
    onSelectWorkspace?.(workspaceId);
  });

  function captureRecentViewport() {
    const scrollTop = Number(recentSection.scrollTop || 0);
    if (scrollTop <= LATEST_SCROLL_THRESHOLD_PX) {
      return { followLatest: true, scrollTop };
    }

    const sectionRect = recentSection.getBoundingClientRect();
    const viewportTop = sectionRect.top;
    for (const node of recentList.children) {
      const rect = node.getBoundingClientRect();
      const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height;
      if (bottom > viewportTop) {
        return {
          followLatest: false,
          scrollTop,
          anchorId: node.dataset.activityId,
          anchorOffset: rect.top - viewportTop,
        };
      }
    }
    return { followLatest: false, scrollTop };
  }

  function restoreRecentViewport(viewport) {
    if (viewport.followLatest) {
      recentSection.scrollTop = 0;
      return;
    }

    const anchor = viewport.anchorId ? recentNodes.get(viewport.anchorId) : null;
    if (!anchor) {
      recentSection.scrollTop = viewport.scrollTop;
      return;
    }
    const viewportTop = recentSection.getBoundingClientRect().top;
    const anchorOffset = anchor.getBoundingClientRect().top - viewportTop;
    recentSection.scrollTop += anchorOffset - viewport.anchorOffset;
  }

  function render(snapshot) {
    const recentViewport = captureRecentViewport();
    syncList(nowList, snapshot.active || [], nowNodes);
    syncList(recentList, snapshot.recent || [], recentNodes);
    nowSection.hidden = !(snapshot.active || []).length;
    recentSection.hidden = !(snapshot.recent || []).length;
    restoreRecentViewport(recentViewport);
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
