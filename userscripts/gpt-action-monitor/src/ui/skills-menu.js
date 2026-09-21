export function createSkillsMenu({ loadSkills, onBeforeOpen, onSelect }) {
  const root = document.createElement('div');
  root.className = 'gam-skills-picker';
  root.hidden = true;
  root.innerHTML = `
    <div class="gam-skills-picker-header">
      <strong>Skills</strong>
      <button class="gam-skills-refresh" type="button" title="刷新 Skill 列表" aria-label="刷新 Skill 列表">↻</button>
    </div>
    <div class="gam-skills-state" hidden></div>
    <div class="gam-skills-list" role="menu" aria-label="Skills"></div>
  `;

  const refreshButton = root.querySelector('.gam-skills-refresh');
  const state = root.querySelector('.gam-skills-state');
  const list = root.querySelector('.gam-skills-list');
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

  function render(skills) {
    list.replaceChildren();
    clearState();

    if (!skills.length) {
      setState('没有可用 Skill。');
      return;
    }

    for (const skill of skills) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'gam-skill-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = skill.skill_id;
      item.title = skill.description || skill.skill_id;
      item.addEventListener('pointerdown', preserveFocus);
      item.addEventListener('click', () => {
        if (onSelect(skill) !== false) close();
      });
      list.appendChild(item);
    }
    hasRendered = true;
  }

  async function refresh({ force = false } = {}) {
    const generation = ++requestGeneration;
    if (force) setState('刷新中…');
    else if (!hasRendered) setState('加载 Skills…');

    try {
      const skills = await loadSkills({ refresh: force });
      if (!open || generation !== requestGeneration) return;
      render(skills);
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
    onBeforeOpen?.();
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

  refreshButton.addEventListener('pointerdown', preserveFocus);
  refreshButton.addEventListener('click', () => refresh({ force: true }));

  return { element: root, open: openMenu, close, toggle, bindTrigger };
}
