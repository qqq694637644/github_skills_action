export function createSkillsMenu({ loadSkills, onBeforeOpen, onSelect }) {
  const root = document.createElement('div');
  root.className = 'gam-skills-menu';
  root.hidden = true;
  root.innerHTML = `
    <div class="gam-skills-primary">
      <div class="gam-skills-menu-header">
        <strong>Skills</strong>
        <button class="gam-skills-refresh" type="button" title="刷新 Skill 列表" aria-label="刷新 Skill 列表">↻</button>
      </div>
      <div class="gam-skills-list" role="menu" aria-label="Skills"></div>
      <div class="gam-skills-state" hidden></div>
    </div>
    <aside class="gam-skills-detail" hidden>
      <div class="gam-skills-detail-description"></div>
    </aside>
  `;

  const refreshButton = root.querySelector('.gam-skills-refresh');
  const list = root.querySelector('.gam-skills-list');
  const state = root.querySelector('.gam-skills-state');
  const detail = root.querySelector('.gam-skills-detail');
  const detailDescription = root.querySelector('.gam-skills-detail-description');
  let open = false;
  let requestGeneration = 0;
  let hasRendered = false;
  let triggerElement = null;

  function preserveComposerFocus(event) {
    if (event.button === 0) event.preventDefault();
  }

  function hideDetail() {
    detail.hidden = true;
    detailDescription.textContent = '';
  }

  function showDetail(skill) {
    detailDescription.textContent = skill.description || '无 description';
    detail.hidden = false;
  }

  function showState(message) {
    list.replaceChildren();
    state.textContent = message;
    state.hidden = false;
    hideDetail();
  }

  function render(skills) {
    list.replaceChildren();
    state.hidden = true;
    hideDetail();
    if (!skills.length) {
      showState('后端没有可用 Skill。');
      hasRendered = true;
      return;
    }

    for (const skill of skills) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gam-skill-item';
      button.setAttribute('role', 'menuitem');
      button.innerHTML = '<span class="gam-skill-id"></span><span class="gam-skill-chevron">›</span>';
      button.querySelector('.gam-skill-id').textContent = skill.skill_id;
      button.addEventListener('pointerdown', preserveComposerFocus);
      button.addEventListener('pointerenter', () => showDetail(skill));
      button.addEventListener('focus', () => showDetail(skill));
      button.addEventListener('click', () => {
        const accepted = onSelect(skill);
        if (accepted !== false) closeMenu();
      });
      list.appendChild(button);
    }
    hasRendered = true;
  }

  async function refresh({ force = false } = {}) {
    const generation = ++requestGeneration;
    if (hasRendered) {
      state.textContent = force ? '正在刷新…' : '正在读取 Skills…';
      state.hidden = false;
    } else {
      showState('正在读取 Skills…');
    }
    try {
      const skills = await loadSkills({ refresh: force });
      if (!open || generation !== requestGeneration) return;
      render(skills);
    } catch (error) {
      if (!open || generation !== requestGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      if (hasRendered) {
        state.textContent = message;
        state.hidden = false;
      } else {
        showState(message);
      }
    }
  }

  function onDocumentPointerDown(event) {
    if (root.contains(event.target) || triggerElement?.contains?.(event.target)) return;
    closeMenu();
  }

  function onDocumentKeyDown(event) {
    if (event.key === 'Escape') closeMenu();
  }

  function openMenu() {
    if (open) return;
    onBeforeOpen?.();
    open = true;
    root.hidden = false;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    refresh();
  }

  function closeMenu() {
    if (!open) return;
    open = false;
    requestGeneration += 1;
    root.hidden = true;
    hideDetail();
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
  }

  function toggle() {
    if (open) closeMenu();
    else openMenu();
  }

  function bindTrigger(element) {
    triggerElement = element;
  }

  refreshButton.addEventListener('pointerdown', preserveComposerFocus);
  refreshButton.addEventListener('click', () => refresh({ force: true }));

  return { element: root, open: openMenu, close: closeMenu, toggle, bindTrigger };
}
