export class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

export class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.textContent = '';
    this.title = '';
    this.id = '';
    this.isConnected = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 100;
    this._selectors = new Map();
    this._queryResults = new Map();
    this._matches = false;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value.includes('gam-handle')) {
      for (const selector of [
        '.gam-handle',
        '.gam-skills-button',
        '.gam-close',
        '.gam-header',
        '.gam-expanded',
        '.gam-activity-root',
        '.gam-current-action',
        '.gam-current-detail',
      ]) {
        const element = new FakeElement(selector.slice(1));
        element.parentElement = this;
        this._selectors.set(selector, element);
      }
    }
    if (value.includes('gam-activity-section')) {
      for (const selector of [
        '.gam-monitor-hint',
        '.gam-now-section',
        '.gam-recent-section',
        '.gam-now-list',
        '.gam-recent-list',
      ]) {
        const element = new FakeElement(selector.slice(1));
        element.parentElement = this;
        this._selectors.set(selector, element);
      }
    }
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get childElementCount() {
    return this.children.length;
  }

  querySelector(selector) {
    return this._selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return this._queryResults.get(selector) || [];
  }

  setQueryResults(selector, elements) {
    this._queryResults.set(selector, elements);
  }

  matches() {
    return this._matches;
  }

  closest() {
    return this._matches ? this : null;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    if (node?.isFragment) {
      for (const child of [...node.children]) this.appendChild(child);
      return node;
    }
    if (node?.parentElement) {
      const siblings = node.parentElement.children;
      const existingIndex = siblings.indexOf(node);
      if (existingIndex >= 0) siblings.splice(existingIndex, 1);
    }
    node.parentElement = this;
    this.children.push(node);
    this.scrollHeight = this.children.length;
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  focus() {}

  getBoundingClientRect() {
    return { left: 100, right: 130, top: 100, width: 30, height: 40 };
  }
}

export class FakeFragment extends FakeElement {
  constructor() {
    super('#fragment');
    this.isFragment = true;
  }
}

export class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.visibilityState = 'visible';
    this.documentElement = new FakeElement('html');
    this.body = new FakeElement('body');
    this.body.isConnected = true;
    this._queryResults = new Map();
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  createDocumentFragment() {
    return new FakeFragment();
  }

  querySelectorAll(selector) {
    return this._queryResults.get(selector) || [];
  }

  setQueryResults(selector, elements) {
    this._queryResults.set(selector, elements);
  }

  addEventListener() {}
}

export class FakeMutationObserver {
  static latest = null;

  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    FakeMutationObserver.latest = this;
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }

  trigger(mutations) {
    this.callback(mutations);
  }
}

export function installDomFixture() {
  const document = new FakeDocument();
  let nextTimer = 1;
  const timers = new Map();
  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener() {},
  };

  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.GM_getValue = () => null;
  globalThis.GM_setValue = () => {};

  return { document, window, timers };
}
