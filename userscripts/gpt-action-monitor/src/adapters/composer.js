const PRIMARY_EDITOR_SELECTOR = '#prompt-textarea.ProseMirror[contenteditable="true"]';
const FALLBACK_EDITOR_SELECTOR = '#prompt-textarea[contenteditable="true"][role="textbox"]';

function containsNode(root, node) {
  if (!root || !node) return false;
  if (root === node) return true;
  return typeof root.contains === 'function' ? root.contains(node) : false;
}

export function createComposerAdapter() {
  let savedEditor = null;
  let savedRange = null;

  function findEditor() {
    return document.querySelector(PRIMARY_EDITOR_SELECTOR)
      || document.querySelector(FALLBACK_EDITOR_SELECTOR);
  }

  function captureSelection() {
    savedEditor = null;
    savedRange = null;

    const editor = findEditor();
    const selection = window.getSelection?.();
    if (!editor || !selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!containsNode(editor, range.commonAncestorContainer)) return false;

    savedEditor = editor;
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
    if (
      editor !== savedEditor
      || !savedRange
      || !containsNode(editor, savedRange.commonAncestorContainer)
    ) {
      return placeCaretAtEnd(editor);
    }
    const selection = window.getSelection?.();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(savedRange);
    return true;
  }

  function insertText(text) {
    const editor = savedEditor?.isConnected ? savedEditor : findEditor();
    if (!editor) return false;

    editor.focus({ preventScroll: true });
    if (!restoreRange(editor)) return false;
    const inserted = typeof document.execCommand === 'function'
      ? document.execCommand('insertText', false, text)
      : false;
    savedEditor = null;
    savedRange = null;
    return Boolean(inserted);
  }

  return { captureSelection, insertText };
}

export function loadSkillsCall(skillId) {
  return `loadSkills(${JSON.stringify([skillId])})`;
}
