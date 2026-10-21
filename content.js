// Captures Chinese text selections and forwards them to the side panel.
// Does nothing unless the side panel is open (session flag `active`).
(() => {
  const CJK = /[㐀-鿿豈-﫿]/;
  const CONTEXT_CHARS = 200;
  const DEBOUNCE_MS = 400;

  let active = false;
  let lastSent = '';
  let timer = null;

  chrome.storage.session.get('active').then(
    (r) => { active = !!r.active; },
    () => {}
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && 'active' in changes) {
      active = !!changes.active.newValue;
      if (!active) lastSent = '';
    }
  });

  function surroundingContext(sel, text) {
    const node = sel.anchorNode;
    const block =
      (node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement))
        ?.closest('p, li, td, blockquote, h1, h2, h3, h4, h5, h6, div') || null;
    const full = (block?.innerText || block?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!full || full === text) return '';
    const idx = full.indexOf(text);
    if (idx === -1) return full.slice(0, CONTEXT_CHARS * 2);
    const start = Math.max(0, idx - CONTEXT_CHARS);
    return full.slice(start, idx + text.length + CONTEXT_CHARS);
  }

  function send(text, context) {
    if (text === lastSent) return;
    lastSent = text;
    chrome.runtime
      .sendMessage({ type: 'selection', text, context, url: location.href })
      .catch(() => {}); // panel closed or extension reloaded
  }

  function checkSelection() {
    if (!active) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text || !CJK.test(text)) return;
    send(text, surroundingContext(sel, text));
  }

  function schedule() {
    if (!active) return;
    clearTimeout(timer);
    timer = setTimeout(checkSelection, DEBOUNCE_MS);
  }

  document.addEventListener('selectionchange', schedule);
  document.addEventListener('mouseup', schedule);
  document.addEventListener('keyup', schedule);

  // Let the panel check the clipboard right away instead of waiting for
  // its next poll (Google Docs, and pages where selection isn't in the DOM).
  document.addEventListener('copy', () => {
    if (!active) return;
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'clipboard-changed' }).catch(() => {});
    }, 50);
  });
})();
