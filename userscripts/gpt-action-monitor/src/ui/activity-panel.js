import { presentActivity, presentActivityHover } from '../activity/presentation.js';

function formatLocalTime(timestamp) {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

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
  node._gam.cell = cell;
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
  node.removeAttribute?.('title');
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
  const tooltip = document.createElement('div');
  tooltip.className = 'gam-activity-tooltip';
  tooltip.hidden = true;
  tooltip.innerHTML = `
    <div class="gam-activity-tooltip-time-row">
      <span>最后活动</span>
      <strong class="gam-activity-tooltip-time"></strong>
    </div>
    <div class="gam-activity-tooltip-section">
      <div class="gam-activity-tooltip-label">调用</div>
      <pre class="gam-activity-tooltip-call"></pre>
    </div>
    <div class="gam-activity-tooltip-section">
      <div class="gam-activity-tooltip-label gam-activity-tooltip-output-label"></div>
      <pre class="gam-activity-tooltip-output"></pre>
    </div>
  `;
  root.appendChild(tooltip);
  const tooltipTime = tooltip.querySelector('.gam-activity-tooltip-time');
  const tooltipCall = tooltip.querySelector('.gam-activity-tooltip-call');
  const tooltipOutputLabel = tooltip.querySelector('.gam-activity-tooltip-output-label');
  const tooltipOutput = tooltip.querySelector('.gam-activity-tooltip-output');
  let hoveredNode = null;

  function positionTooltip(node) {
    const anchor = node.getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    const margin = 8;
    let left = anchor.left - rect.width - margin;
    if (left < margin) left = Math.min(anchor.right + margin, window.innerWidth - rect.width - margin);
    const top = Math.min(
      Math.max(anchor.top, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    );
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function showTooltip(node) {
    const cell = node?._gam?.cell;
    if (!cell) return;
    const detail = presentActivityHover(cell);
    tooltipTime.textContent = formatLocalTime(detail.updatedAt);
    tooltipCall.textContent = detail.call;
    tooltipOutputLabel.textContent = detail.outputLabel;
    tooltipOutput.textContent = detail.output;
    tooltip.hidden = false;
    positionTooltip(node);
    hoveredNode = node;
  }

  function hideTooltip() {
    tooltip.hidden = true;
    hoveredNode = null;
  }

  root.addEventListener('pointerover', (event) => {
    const node = event.target.closest?.('.gam-activity-cell');
    if (!node || node === hoveredNode) return;
    showTooltip(node);
  });
  root.addEventListener('pointerout', (event) => {
    const node = event.target.closest?.('.gam-activity-cell');
    if (!node || node !== hoveredNode) return;
    if (event.relatedTarget && node.contains?.(event.relatedTarget)) return;
    hideTooltip();
  });

  function render(snapshot) {
    syncList(nowList, snapshot.active || [], nowNodes);
    syncList(recentList, snapshot.recent || [], recentNodes);
    nowSection.hidden = !(snapshot.active || []).length;
    recentSection.hidden = !(snapshot.recent || []).length;
    if (hoveredNode?._gam?.cell) showTooltip(hoveredNode);
  }

  function setHint(message) {
    hint.textContent = message || '';
    hint.hidden = !message;
  }

  function clear() {
    hideTooltip();
    nowNodes.clear();
    recentNodes.clear();
    nowList.replaceChildren();
    recentList.replaceChildren();
    nowSection.hidden = true;
    recentSection.hidden = true;
  }

  return { render, setHint, clear };
}
