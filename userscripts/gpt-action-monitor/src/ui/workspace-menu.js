function shortWorkspaceId(workspaceId) {
  if (!workspaceId) return 'Workspace ▾';
  return `${workspaceId.slice(0, 11)}… ▾`;
}

export function createWorkspaceMenu({ loadWorkspaces, getSelectedId, onSelect }) {
  const root = document.createElement('div');
  root.className = 'gam-workspace-picker';
  root.hidden = true;
  root.innerHTML = `
    <div class="gam-workspace-picker-header">
      <strong>Workspace</strong>
      <button class="gam-workspace-refresh" type="button" title="刷新 Workspace 列表" aria-label="刷新 Workspace 列表">↻</button>
    </div>
    <div class="gam-workspace-state" hidden></div>
    <div class="gam-workspace-list" role="menu" aria-label="Workspaces"></div>
  `;

  const refreshButton = root.querySelector('.gam-workspace-refresh');
  const state = root.querySelector('.gam-workspace-state');
  const list = root.querySelector('.gam-workspace-list');
  let open = false;
  let hasRendered = false;
  let requestGeneration = 0;
  let triggerElement = null;

  function preserveFocus(event) {
    if (event.button === 0) event.preventDefault();
  }

  function setState(message) {
    state.textContent = message;
    state.hidden = false;
  }

  function clearState() {
    state.hidden = true;
    state.textContent = '';
  }

  function render(workspaces) {
    list.replaceChildren();
    clearState();

    if (!workspaces.length) {
      setState('没有可用 Workspace。');
      hasRendered = true;
      return;
    }

    const selectedId = getSelectedId?.() || '';
    for (const workspaceId of workspaces) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gam-workspace-item';
      item.dataset.selected = workspaceId === selectedId ? 'true' : 'false';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', workspaceId === selectedId ? 'true' : 'false');
      item.textContent = workspaceId;
      item.title = workspaceId;
      item.addEventListener('pointerdown', preserveFocus);
      item.addEventListener('click', () => {
        if (onSelect(workspaceId) !== false) close();
      });
      list.appendChild(item);
    }
    hasRendered = true;
  }

  async function refresh({ force = false } = {}) {
    const generation = ++requestGeneration;
    if (force) setState('刷新中…');
    else if (!hasRendered) setState('加载 Workspace…');

    try {
      const workspaces = await loadWorkspaces({ refresh: force });
      if (!open || generation !== requestGeneration) return;
      render(workspaces);
    } catch (error) {
      if (!open || generation !== requestGeneration) return;
      setState(error instanceof Error ? error.message : String(error));
    }
  }

  function close() {
    if (!open) return;
    open = false;
    requestGeneration += 1;
    root.hidden = true;
    document.removeEventListener('pointerdown', outsidePointer, true);
    document.removeEventListener('keydown', escapeKey, true);
  }

  function outsidePointer(event) {
    if (root.contains(event.target) || triggerElement?.contains?.(event.target)) return;
    close();
  }

  function escapeKey(event) {
    if (event.key === 'Escape') close();
  }

  function openMenu() {
    if (open) return;
    open = true;
    root.hidden = false;
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('keydown', escapeKey, true);
    refresh();
  }

  function toggle() {
    if (open) close();
    else openMenu();
  }

  function bindTrigger(element) {
    triggerElement = element;
  }

  function updateTrigger() {
    if (!triggerElement) return;
    const workspaceId = getSelectedId?.() || '';
    triggerElement.textContent = shortWorkspaceId(workspaceId);
    triggerElement.title = workspaceId || '选择 Workspace';
  }

  function reset() {
    close();
    hasRendered = false;
    requestGeneration += 1;
    list.replaceChildren();
    clearState();
    updateTrigger();
  }

  refreshButton.addEventListener('pointerdown', preserveFocus);
  refreshButton.addEventListener('click', () => refresh({ force: true }));

  return {
    element: root,
    open: openMenu,
    close,
    toggle,
    bindTrigger,
    updateTrigger,
    reset,
  };
}
