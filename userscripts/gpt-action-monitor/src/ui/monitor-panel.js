import { ACTIVITY_VISIBLE_MS, COMPACT_WIDTH, POSITION_KEY, UI_COALESCE_MS } from '../constants.js';
import { MONITOR_CSS } from './styles.js';
import { createActivityPanel } from './activity-panel.js';

export function createMonitorPanel({ activityStore, isActive, skillsMenu = null }) {
  const panel = document.createElement('div');
  panel.id = 'gpt-action-monitor';
  panel.dataset.status = 'idle';
  panel.innerHTML = `
    <div class="gam-compact">
      <div class="gam-chip" role="status" aria-live="polite" aria-atomic="true">
        <strong class="gam-current-action">GPT Actions</strong>
        <span class="gam-current-detail">等待 Action</span>
      </div>
      <button class="gam-handle" type="button" title="拖动移动 · 点击展开" aria-label="展开 GPT Activity">
        <span class="gam-dot"></span>
      </button>
    </div>
    <section class="gam-expanded" aria-label="GPT Activity">
      <div class="gam-header">
        <span><span class="gam-dot gam-header-dot"></span>GPT Actions</span>
        <div class="gam-header-controls">
          <button class="gam-skills-button" type="button" aria-haspopup="menu" aria-label="打开 Skills">Skills ›</button>
          <button class="gam-close" type="button" title="收起" aria-label="收起 GPT Activity">−</button>
        </div>
      </div>
      <div class="gam-activity-root" role="log" aria-label="Agent activity"></div>
    </section>
  `;

  const style = document.createElement('style');
  style.textContent = MONITOR_CSS;

  const handle = panel.querySelector('.gam-handle');
  const close = panel.querySelector('.gam-close');
  const skillsButton = panel.querySelector('.gam-skills-button');
  const header = panel.querySelector('.gam-header');
  const activityRoot = panel.querySelector('.gam-activity-root');
  const currentAction = panel.querySelector('.gam-current-action');
  const currentDetail = panel.querySelector('.gam-current-detail');
  const activityPanel = createActivityPanel({ root: activityRoot });
  if (skillsMenu?.element) panel.querySelector('.gam-expanded').appendChild(skillsMenu.element);
  skillsMenu?.bindTrigger?.(skillsButton);

  let manualOpen = false;
  let suppressHandleClick = false;
  let activityTimer = null;
  let uiTimer = null;
  let pendingLatest = null;
  let lastHint = '';

  activityStore.subscribe((snapshot) => {
    if (manualOpen) activityPanel.render(snapshot);
  });

  function setStatus(state) {
    panel.dataset.status = state;
  }

  function getStatus() {
    return panel.dataset.status;
  }

  function updateChipSide() {
    if (panel.classList.contains('gam-open')) return;
    const rect = panel.getBoundingClientRect();
    panel.classList.toggle('gam-chip-right', rect.left < 275);
  }

  function savePosition() {
    const rect = panel.getBoundingClientRect();
    const docked = !panel.classList.contains('gam-detached');
    const compactLeft = panel.classList.contains('gam-open') ? rect.right - COMPACT_WIDTH : rect.left;
    GM_setValue(POSITION_KEY, {
      top: Math.round(rect.top),
      left: docked ? null : Math.round(compactLeft),
      docked,
    });
  }

  function keepInViewport() {
    if (!panel.isConnected) return;
    const rect = panel.getBoundingClientRect();
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    panel.style.top = `${Math.round(Math.min(Math.max(rect.top, 8), maxTop))}px`;
    if (panel.classList.contains('gam-detached')) {
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      panel.style.left = `${Math.round(Math.min(Math.max(rect.left, 8), maxLeft))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.left = 'auto';
      panel.style.right = '0';
    }
    updateChipSide();
  }

  function restorePosition() {
    const saved = GM_getValue(POSITION_KEY, null);
    if (!saved || typeof saved !== 'object') {
      updateChipSide();
      return;
    }
    if (Number.isFinite(saved.top)) panel.style.top = `${saved.top}px`;
    if (saved.docked === false && Number.isFinite(saved.left)) {
      panel.classList.add('gam-detached');
      panel.style.left = `${saved.left}px`;
      panel.style.right = 'auto';
    }
    keepInViewport();
  }

  function makeDraggable(dragHandle, { suppressClick = false } = {}) {
    dragHandle.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0
        || event.target.closest('.gam-close, .gam-skills-button, .gam-skills-menu')
      ) return;
      const startRect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      panel.classList.add('gam-dragging');
      dragHandle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 4) return;
        if (!dragging) {
          dragging = true;
          panel.classList.add('gam-detached');
          panel.style.left = `${Math.round(startRect.left)}px`;
          panel.style.right = 'auto';
        }
        const width = panel.getBoundingClientRect().width;
        const height = panel.getBoundingClientRect().height;
        const left = Math.min(Math.max(startRect.left + dx, 8), Math.max(8, window.innerWidth - width - 8));
        const top = Math.min(Math.max(startRect.top + dy, 8), Math.max(8, window.innerHeight - height - 8));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        updateChipSide();
      };

      const onEnd = () => {
        dragHandle.removeEventListener('pointermove', onMove);
        dragHandle.removeEventListener('pointerup', onEnd);
        dragHandle.removeEventListener('pointercancel', onEnd);
        panel.classList.remove('gam-dragging');
        if (!dragging) return;
        const rect = panel.getBoundingClientRect();
        if (window.innerWidth - rect.right < 28) {
          panel.classList.remove('gam-detached');
          panel.style.left = 'auto';
          panel.style.right = '0';
        }
        keepInViewport();
        savePosition();
        if (suppressClick) suppressHandleClick = true;
      };

      dragHandle.addEventListener('pointermove', onMove);
      dragHandle.addEventListener('pointerup', onEnd);
      dragHandle.addEventListener('pointercancel', onEnd);
    });
  }

  function openHistory() {
    if (suppressHandleClick) {
      suppressHandleClick = false;
      return;
    }
    const compactRect = panel.getBoundingClientRect();
    const rightEdge = compactRect.right;
    manualOpen = true;
    panel.classList.remove('gam-chip-visible');
    panel.classList.add('gam-open');
    if (panel.classList.contains('gam-detached')) {
      const width = panel.getBoundingClientRect().width;
      panel.style.left = `${Math.round(rightEdge - width)}px`;
    }
    keepInViewport();
    activityPanel.render(activityStore.snapshot());
  }

  function closeHistory() {
    const openRect = panel.getBoundingClientRect();
    const rightEdge = openRect.right;
    manualOpen = false;
    skillsMenu?.close();
    panel.classList.remove('gam-open');
    if (panel.classList.contains('gam-detached')) {
      panel.style.left = `${Math.round(rightEdge - COMPACT_WIDTH)}px`;
    }
    activityPanel.clear();
    keepInViewport();
    savePosition();
    handle.focus();
  }

  function hideActivity() {
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'active') setStatus('idle');
  }

  function flushActivity() {
    uiTimer = null;
    if (!pendingLatest) return;
    const summary = pendingLatest;
    pendingLatest = null;
    currentAction.textContent = summary.action;
    currentDetail.textContent = summary.detail;
    setStatus(summary.status === 'failed' ? 'error' : 'active');
    if (!manualOpen) panel.classList.add('gam-chip-visible');
    window.clearTimeout(activityTimer);
    activityTimer = null;
    if (summary.status !== 'active') {
      activityTimer = window.setTimeout(hideActivity, ACTIVITY_VISIBLE_MS);
    }
  }

  function queueActivity(summary) {
    pendingLatest = summary;
    if (!isActive() || uiTimer !== null || document.visibilityState !== 'visible') return;
    uiTimer = window.setTimeout(flushActivity, UI_COALESCE_MS);
  }

  function showAttention(action, detail) {
    pendingLatest = null;
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    window.clearTimeout(activityTimer);
    currentAction.textContent = action;
    currentDetail.textContent = detail;
    setStatus('error');
    if (!manualOpen) panel.classList.add('gam-chip-visible');
  }

  function clearAttention() {
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'error') setStatus('idle');
  }

  function resetSession() {
    pendingLatest = null;
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    if (activityTimer !== null) {
      window.clearTimeout(activityTimer);
      activityTimer = null;
    }
  }

  function recordHint(message) {
    if (!message || message === lastHint) return;
    lastHint = message;
    activityPanel.setHint(message);
  }

  function clearHint() {
    lastHint = '';
    activityPanel.setHint('');
  }

  function suspendActivity() {
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    window.clearTimeout(activityTimer);
    activityTimer = null;
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'active') setStatus('idle');
  }

  function resumeActivity() {
    if (pendingLatest) queueActivity(pendingLatest);
  }

  function mount() {
    if (!style.isConnected) document.documentElement.appendChild(style);
    if (!panel.isConnected) document.body.appendChild(panel);
    restorePosition();
  }

  function unmount() {
    if (panel.isConnected) savePosition();
    resetSession();
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'active') setStatus('idle');
    panel.classList.remove('gam-open', 'gam-chip-visible', 'gam-dragging');
    manualOpen = false;
    skillsMenu?.close();
    activityPanel.clear();
    panel.remove();
    style.remove();
  }

  makeDraggable(handle, { suppressClick: true });
  makeDraggable(header);
  handle.addEventListener('click', openHistory);
  skillsButton.addEventListener('pointerdown', (event) => {
    if (event.button === 0) event.preventDefault();
  });
  skillsButton.addEventListener('click', () => skillsMenu?.toggle());
  close.addEventListener('click', closeHistory);

  return {
    mount,
    unmount,
    keepInViewport,
    setStatus,
    getStatus,
    recordHint,
    clearHint,
    queueActivity,
    showAttention,
    clearAttention,
    resetSession,
    suspendActivity,
    resumeActivity,
  };
}
