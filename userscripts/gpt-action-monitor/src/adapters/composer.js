const CONTENTEDITABLE_SELECTOR = '[data-composer-body] #prompt-textarea[contenteditable="true"], #prompt-textarea[contenteditable="true"]';
const TEXTAREA_SELECTOR = '[data-composer-body] textarea[name="prompt-textarea"], textarea[name="prompt-textarea"]';

function containsNode(root, node) {
  if (!root || !node) return false;
  if (root === node) return true;
  return typeof root.contains === 'function' ? root.contains(node) : false;
}

export function createComposerAdapter() {
  let savedRange = null;
  let savedTextareaSelection = null;

  function findContenteditable() {
    return document.querySelector(CONTENTEDITABLE_SELECTOR);
  }

  function findTextarea() {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    return textarea && textarea.offsetParent !== null ? textarea : null;
  }

  function captureSelection() {
    savedRange = null;
    savedTextareaSelection = null;

    const textarea = findTextarea();
    if (textarea && document.activeElement === textarea) {
      savedTextareaSelection = {
        element: textarea,
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
      return true;
    }

    const editor = findContenteditable();
    const selection = window.getSelection?.();
    if (!editor || !selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!containsNode(editor, range.commonAncestorContainer)) return false;
    savedRange = range.cloneRange();
    return true;
  }

  function placeCaretAtEnd(editor) {
    const selection = window.getSelection?.();
    if (!selection || typeof document.createRange !== 'function') return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function restoreRange(editor) {
    if (!savedRange || !containsNode(editor, savedRange.commonAncestorContainer)) {
      return placeCaretAtEnd(editor);
    }
    const selection = window.getSelection?.();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(savedRange);
    return true;
  }

  function insertIntoTextarea(textarea, text) {
    const saved = savedTextareaSelection?.element === textarea ? savedTextareaSelection : null;
    const start = saved?.start ?? textarea.selectionStart ?? textarea.value.length;
    const end = saved?.end ?? textarea.selectionEnd ?? start;
    textarea.focus({ preventScroll: true });
    textarea.setRangeText(text, start, end, 'end');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  function insertText(text) {
    const textarea = findTextarea();
    if (textarea) {
      const inserted = insertIntoTextarea(textarea, text);
      savedTextareaSelection = null;
      savedRange = null;
      return inserted;
    }

    const editor = findContenteditable();
    if (!editor) return false;
    editor.focus({ preventScroll: true });
    restoreRange(editor);
    const inserted = typeof document.execCommand === 'function'
      ? document.execCommand('insertText', false, text)
      : false;
    savedRange = null;
    savedTextareaSelection = null;
    return Boolean(inserted);
  }

  return { captureSelection, insertText };
}

export function loadSkillsCall(skillId) {
  return `loadSkills(${JSON.stringify([skillId])})`;
}
