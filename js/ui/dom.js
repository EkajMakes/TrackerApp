/** Tiny element helpers shared by the ui/ modules. Presentation only. */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** "+16" / "-40" / "0" — sign is meaning here, so it is always shown. */
export function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

export function empty(message) {
  return el('p', 'empty', message);
}
