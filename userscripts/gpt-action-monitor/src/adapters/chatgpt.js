import { GPT_TITLE_SELECTOR } from '../constants.js';

export function createChatGPTAdapter({ getProfiles, onActivate, onDeactivate }) {
  let observer = null;
  let activeTitleElement = null;
  let activeProfileId = null;

  function titleName(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function matchingProfile(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || !element.matches(GPT_TITLE_SELECTOR)) return null;
    return getProfiles().find((profile) => profile.enabled && profile.gptName === titleName(element)) || null;
  }

  function findTargetTitle(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE) {
      const profile = matchingProfile(root);
      if (profile) return { element: root, profile };
    }
    if (typeof root.querySelectorAll !== 'function') return null;
    for (const element of root.querySelectorAll(GPT_TITLE_SELECTOR)) {
      const profile = matchingProfile(element);
      if (profile) return { element, profile };
    }
    return null;
  }

  function evaluateActivation() {
    const target = findTargetTitle(document);
    if (target) activate(target.element, target.profile);
    else deactivate();
  }

  function activate(element, profile) {
    activeTitleElement = element;
    activeProfileId = profile.id;
    onActivate(element, profile);
  }

  function deactivate() {
    activeTitleElement = null;
    activeProfileId = null;
    onDeactivate();
  }

  function targetFromMutation(mutation) {
    const mutationElement = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    const containingTitle = mutationElement?.closest?.(GPT_TITLE_SELECTOR);
    const containingProfile = matchingProfile(containingTitle);
    if (containingProfile) return { element: containingTitle, profile: containingProfile };
    for (const node of mutation.addedNodes) {
      const target = findTargetTitle(node);
      if (target) return target;
    }
    return null;
  }

  function start() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (activeProfileId) {
        const currentProfile = activeTitleElement?.isConnected
          ? matchingProfile(activeTitleElement)
          : null;
        if (currentProfile?.id === activeProfileId) return;
        evaluateActivation();
        return;
      }

      for (const mutation of mutations) {
        const target = targetFromMutation(mutation);
        if (target) {
          activate(target.element, target.profile);
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    evaluateActivation();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
  }

  return { start, stop, evaluateActivation };
}
