/**
 * The smallest DOM the ui/ modules actually touch, so they can be rendered
 * under `node --test` without pulling in a dependency.
 *
 * This is deliberately not a browser: it records structure, which is what the
 * render tests assert on. Anything a module needs that is missing here will
 * throw loudly rather than silently pass.
 */

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.ownText = '';
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this._classes = new Set();

    this.classList = {
      add: (...names) => names.forEach((n) => n && this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const on = force ?? !this._classes.has(name);
        if (on) this._classes.add(name);
        else this._classes.delete(name);
        return on;
      },
    };
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent ?? '').join('');
  }

  set textContent(value) {
    this.children = [];
    this.ownText = value === null || value === undefined ? '' : String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'object' ? node : Object.assign(new StubElement('span'), { ownText: String(node) });
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name) {
    return name in this.attributes;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** Fire a listener the way a tap would. */
  click() {
    for (const handler of this.listeners.get('click') ?? []) {
      handler({ stopPropagation() {}, timeStamp: 0, clientX: 0, clientY: 0, target: this });
    }
  }

  /** Every descendant, self included, flattened. */
  walk() {
    return [this, ...this.children.flatMap((c) => (c.walk ? c.walk() : [c]))];
  }

  queryAll(selector) {
    const wanted = selector.replace(/^\./, '');
    return this.walk().filter((n) => n._classes?.has(wanted) || n.tagName === selector.toUpperCase());
  }
}

export function installDom() {
  const document = {
    createElement: (tag) => new StubElement(tag),
    createElementNS: (_ns, tag) => new StubElement(tag),
    body: new StubElement('body'),
    addEventListener() {},
  };
  globalThis.document = document;
  globalThis.setTimeout = globalThis.setTimeout ?? (() => 0);
  return document;
}

export { StubElement };
