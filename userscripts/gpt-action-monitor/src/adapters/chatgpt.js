export function createChatGPTAdapter({ getProfiles, onMatch }) {
  function titleName(element) {
    return element?.textContent?.trim() || '';
  }

  function findTargetTitle(root = document) {
    return [...root.querySelectorAll('div[type="button"][aria-haspopup="menu"]')]
      .find((element) => titleName(element));
  }

  function matchingProfile(element) {
    const name = titleName(element);
    return getProfiles().find((profile) => profile.enabled && profile.gptName === name) || null;
  }

  function evaluate(root = document) {
    const target = findTargetTitle(root);
    const profile = target ? matchingProfile(target) : null;
    if (profile) onMatch(target, profile);
  }

  let observer = null;

  function start() {
    evaluate();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
          evaluate(mutation.target);
          break;
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
  }

  return { start, stop, evaluate };
}
