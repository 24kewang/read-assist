import { streamGemini, buildPrompts, parseSections, parseRows, DEFAULT_MODEL } from './gemini.js';
import { loadDictionary, lookupWord } from './cedict.js';

const CJK = /[㐀-鿿豈-﫿]/;
const CJK_ALL = /[㐀-鿿豈-﫿]/g;
const SENTENCE_PUNCT = /[。！？；，、：,.!?;:]/;
const WORD_MAX_CHARS = 6;
const CACHE_LIMIT = 100;
const CLIPBOARD_POLL_MS = 700;

const $ = (id) => document.getElementById(id);
const ui = {
  empty: $('empty'),
  view: $('view'),
  selection: $('selection'),
  modeLabel: $('mode-label'),
  status: $('status'),
  results: $('results'),
  manualInput: $('manual-input')
};

let settings = { apiKey: '', model: DEFAULT_MODEL, toneType: 'symbol', autoClipboard: true };
let modeOverride = 'auto';
let current = null; // { text, context }
let inflight = null;
const cache = new Map();

// --- Active-state handshake: the port stays open as long as this panel is.
const port = chrome.runtime.connect({ name: 'sidepanel' });
port.onMessage.addListener((msg) => {
  if (msg.type === 'read-clipboard') lookupClipboard();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'selection') lookup(msg.text, msg.context);
  else if (msg.type === 'clipboard-changed') checkClipboard();
});

// --- Settings
async function loadSettings() {
  const s = await chrome.storage.local.get(['apiKey', 'model', 'toneType', 'autoClipboard']);
  settings = {
    apiKey: s.apiKey || '',
    model: s.model || DEFAULT_MODEL,
    toneType: s.toneType || 'symbol',
    autoClipboard: s.autoClipboard !== false
  };
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const hadKey = !!settings.apiKey;
  loadSettings().then(() => {
    if (!current) return;
    if ('toneType' in changes) renderSelection(current.text);
    if (!hadKey && settings.apiKey) run();
  });
});

// --- Helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === '') continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function detectMode(text) {
  const n = (text.match(CJK_ALL) || []).length;
  return n <= WORD_MAX_CHARS && !SENTENCE_PUNCT.test(text) ? 'word' : 'passage';
}

function effectiveMode(text) {
  return modeOverride === 'auto' ? detectMode(text) : modeOverride;
}

function toPinyinArray(text) {
  const chars = Array.from(text);
  const py = window.pinyinPro.pinyin(text, {
    type: 'array',
    toneType: settings.toneType === 'num' ? 'num' : 'symbol',
    nonZh: 'consecutive'
  });
  // Fall back to per-character conversion if the arrays don't line up.
  if (py.length === chars.length) return chars.map((c, i) => [c, py[i]]);
  return chars.map((c) => [c, CJK.test(c) ? window.pinyinPro.pinyin(c, { toneType: settings.toneType === 'num' ? 'num' : 'symbol' }) : '']);
}

function renderSelection(text) {
  ui.selection.replaceChildren();
  ui.selection.classList.toggle('long', Array.from(text).length > 20);
  let plain = '';
  const flush = () => { if (plain) { ui.selection.append(plain); plain = ''; } };
  for (const [ch, py] of toPinyinArray(text)) {
    if (CJK.test(ch)) {
      flush();
      ui.selection.append(el('ruby', {}, ch, el('rt', {}, py)));
    } else {
      plain += ch;
    }
  }
  flush();
}

function setStatus(content, { error = false, loading = false } = {}) {
  ui.status.hidden = !content;
  ui.status.classList.toggle('error', error);
  ui.status.replaceChildren();
  if (loading) ui.status.append(el('span', { class: 'spinner' }));
  if (content) ui.status.append(content);
}

const para = (text, cls = '', lang = 'zh') => text ? el('p', { class: cls, lang }, text) : null;
const prose = (lang = 'zh', cls = '') => (raw) =>
  raw.split(/\n+/).filter(Boolean).map((t) => para(t, cls, lang));

// --- Section renderers (each takes the raw, possibly partial, section text)
function renderEntries(raw) {
  return parseRows(raw).map(([word, py, pos, zh, en]) =>
    el('div', { class: 'entry' },
      el('div', { class: 'entry-head' },
        el('span', { class: 'entry-word', lang: 'zh' }, word),
        el('span', { class: 'entry-pinyin' }, py),
        pos ? el('span', { class: 'pos' }, pos) : null),
      para(zh),
      para(en, 'entry-en', 'en')));
}

// Instant definitions from the bundled dictionary, shown until the AI's
// definition (which adds simple-Chinese explanations) has fully arrived.
function renderLocalEntries(list) {
  const nodes = list.map((e) =>
    el('div', { class: 'entry' },
      el('div', { class: 'entry-head' },
        el('span', { class: 'entry-word', lang: 'zh' }, e.word),
        el('span', { class: 'entry-pinyin' }, e.pinyin)),
      para(e.defs.join('; '), 'entry-en', 'en')));
  const source = el('p', { class: 'source' }, 'CC-CEDICT');
  if (settings.apiKey) source.prepend(el('span', { class: 'spinner' }), 'AI definition loading · ');
  return [...nodes, source];
}

async function showLocalDefinition(slot, text, signal) {
  let list;
  try {
    list = await lookupWord(text, settings.toneType);
  } catch (err) {
    console.error('CC-CEDICT lookup failed', err);
    return;
  }
  if (signal.aborted || slot.ai || !list.length) return;
  slot.body.replaceChildren(...renderLocalEntries(list));
  slot.node.hidden = false;
  slot.filled = true;
  slot.local = true;
}

function renderExamples(raw) {
  return el('ul', { class: 'examples' }, parseRows(raw).map(([zh, py, en]) =>
    el('li', {},
      el('div', { lang: 'zh' }, zh),
      py ? el('div', { class: 'ex-pinyin' }, py) : null,
      en ? el('div', { class: 'ex-en', lang: 'en' }, en) : null)));
}

function renderVocab(raw) {
  return el('table', { class: 'vocab' }, parseRows(raw).map(([word, py, en]) =>
    el('tr', {},
      el('td', { lang: 'zh' }, word),
      el('td', {}, py || ''),
      el('td', { lang: 'en' }, en || ''))));
}

// Cards in display order. `req` says which of the two parallel requests
// produces the section; primary holds what matters most.
const SECTIONS = {
  word: [
    { id: 'entries', req: 'primary', title: '释义 · Definition', render: renderEntries },
    { id: 'explanation', req: 'primary', title: '深入解释 · Explanation', render: prose() },
    { id: 'examples', req: 'secondary', title: '例句 · Examples', render: renderExamples },
    { id: 'usage', req: 'secondary', title: '用法 · Usage notes', render: prose() }
  ],
  passage: [
    { id: 'translation', req: 'primary', title: 'English', render: prose('en', 'big-en') },
    { id: 'explanation', req: 'primary', title: '深入解读 · Deeper meaning', render: prose() },
    { id: 'paraphrase', req: 'primary', title: '简单地说 · In simple Chinese', render: prose() },
    { id: 'vocab', req: 'secondary', title: '重点词语 · Key vocabulary', render: renderVocab },
    { id: 'notes', req: 'secondary', title: '语法与文化 · Notes', render: prose() }
  ]
};

function createSlots(mode) {
  return SECTIONS[mode].map((sec) => {
    const body = el('div', { class: 'card-body' }, el('div', { class: 'shimmer' }), el('div', { class: 'shimmer short' }));
    const node = el('section', { class: 'card', 'data-section': sec.id }, el('h3', {}, sec.title), body);
    ui.results.append(node);
    return { ...sec, node, body, filled: false };
  });
}

function fillSlots(slots, text, done = false) {
  const parsed = parseSections(text);
  const order = Object.keys(parsed);
  for (const slot of slots) {
    const raw = parsed[slot.id];
    if (!raw) continue;
    // Keep a dictionary result until the AI's version of the section is
    // complete (a later section has started, or the stream ended).
    const complete = done || order.indexOf(slot.id) < order.length - 1;
    if (slot.local && !complete) continue;
    slot.body.replaceChildren(...[slot.render(raw)].flat().filter(Boolean));
    slot.filled = true;
    slot.local = false;
    slot.ai = true;
  }
}

function openSettingsLink(label) {
  const a = el('a', { href: '#' }, label);
  a.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  return a;
}

// --- Lookup flow
function lookup(text, context = '') {
  text = (text || '').trim();
  if (!text || !CJK.test(text)) return;
  if (current && current.text === text && current.context === context) return;
  current = { text, context };
  ui.empty.hidden = true;
  ui.view.hidden = false;
  renderSelection(text);
  run();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); }
  return hit;
}

function cachePut(key, req, text) {
  const entry = cache.get(key) || {};
  entry[req] = text;
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

async function run() {
  await settingsReady;
  if (!current) return;
  const { text, context } = current;
  const mode = effectiveMode(text);
  ui.modeLabel.textContent = modeOverride === 'auto' ? `detected: ${mode}` : '';

  inflight?.abort();
  inflight = null;
  ui.results.replaceChildren();
  setStatus('');

  const controller = new AbortController();
  inflight = controller;

  if (!settings.apiKey) {
    const frag = document.createDocumentFragment();
    frag.append('Add your Gemini API key in ', openSettingsLink('Settings'), ' to see explanations and examples.');
    setStatus(frag, { error: true });
    if (mode === 'word') {
      const [slot] = createSlots(mode).filter((s) => s.id === 'entries');
      ui.results.replaceChildren(slot.node);
      slot.node.hidden = true;
      showLocalDefinition(slot, text, controller.signal);
    }
    return;
  }

  const key = `${settings.model}|${mode}|${text}|${context}`;
  const prompts = buildPrompts(mode, text, context);
  const slots = createSlots(mode);
  const cached = cacheGet(key) || {};
  const entriesSlot = slots.find((s) => s.id === 'entries');
  if (entriesSlot) showLocalDefinition(entriesSlot, text, controller.signal);

  // Both requests run in parallel; each fills only its own cards.
  for (const req of ['primary', 'secondary']) {
    const group = slots.filter((s) => s.req === req);
    if (cached[req]) finishGroup(group, cached[req]);
    else streamGroup(req, group, prompts[req], key, controller.signal);
  }
}

// The AI request ended without replacing a dictionary result.
function settleLocal(group) {
  for (const slot of group) {
    if (slot.local) slot.body.querySelector('.source')?.replaceChildren('CC-CEDICT');
  }
}

function finishGroup(group, text) {
  fillSlots(group, text, true);
  settleLocal(group);
  for (const slot of group) if (!slot.filled) slot.node.remove();
}

async function streamGroup(req, group, prompt, key, signal) {
  for (const slot of group) {
    if (slot.filled) continue;
    slot.node.hidden = false;
    slot.body.replaceChildren(el('div', { class: 'shimmer' }), el('div', { class: 'shimmer short' }));
  }
  let text = '';
  try {
    for await (text of streamGemini({ apiKey: settings.apiKey, model: settings.model, prompt, signal })) {
      if (signal.aborted) return;
      fillSlots(group, text);
    }
    if (signal.aborted) return;
    cachePut(key, req, text);
    finishGroup(group, text);
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) return;
    showGroupError(req, group, err, prompt, key, signal);
  }
}

function showGroupError(req, group, err, prompt, key, signal) {
  settleLocal(group);
  const msg = el('p', { class: 'card-error' }, err.message || String(err), ' ');
  const retry = el('button', { class: 'link-btn' }, 'Retry');
  retry.addEventListener('click', () => {
    msg.remove();
    streamGroup(req, group, prompt, key, signal);
  });
  msg.append(retry);
  const unfilled = group.filter((s) => !s.filled);
  if (unfilled.length) {
    unfilled[0].body.replaceChildren(msg);
    for (const s of unfilled.slice(1)) s.node.hidden = true;
  } else {
    group[group.length - 1].body.append(msg);
  }
}

async function readClipboard() {
  // execCommand('paste') works in extension pages with clipboardRead even
  // when the panel isn't focused; navigator.clipboard needs focus.
  const ta = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' });
  document.body.append(ta);
  ta.focus();
  let text = '';
  try {
    if (document.execCommand('paste')) text = ta.value;
  } finally {
    ta.remove();
  }
  if (!text && navigator.clipboard?.readText) {
    try { text = await navigator.clipboard.readText(); } catch {}
  }
  return text;
}

// Auto-lookup on copy. Chrome's PDF viewer gives extensions no copy event,
// so watch the clipboard while the panel is open. Skip while the panel
// itself has focus so the hidden paste target never steals the caret.
let lastClipboard = null;
let checking = false;

async function checkClipboard() {
  if (checking || !settings.autoClipboard || document.hasFocus()) return;
  checking = true;
  try {
    const text = (await readClipboard()).trim();
    if (lastClipboard === null || text === lastClipboard) {
      lastClipboard = text; // first read is a baseline, not a lookup
      return;
    }
    lastClipboard = text;
    // Copying a selection that was already looked up shouldn't refetch.
    if (CJK.test(text) && text !== current?.text) lookup(text);
  } finally {
    checking = false;
  }
}

async function lookupClipboard() {
  const text = (await readClipboard()).trim();
  lastClipboard = text;
  if (!text) {
    ui.empty.hidden = true;
    ui.view.hidden = false;
    setStatus('The clipboard is empty or could not be read.', { error: true });
    return;
  }
  if (!CJK.test(text)) {
    setStatus('The clipboard has no Chinese text.', { error: true });
    ui.empty.hidden = true;
    ui.view.hidden = false;
    return;
  }
  current = null; // force a refresh even if the text matches
  lookup(text);
}

// --- Controls
document.querySelectorAll('.segmented button').forEach((btn) => {
  btn.addEventListener('click', () => {
    modeOverride = btn.dataset.mode;
    document.querySelectorAll('.segmented button').forEach((b) =>
      b.setAttribute('aria-checked', String(b === btn)));
    run();
  });
});

$('settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('clipboard-btn').addEventListener('click', lookupClipboard);

function submitManual() {
  const text = ui.manualInput.value.trim();
  if (!text) return;
  current = null;
  lookup(text);
}
$('manual-btn').addEventListener('click', submitManual);
ui.manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitManual();
  }
});

const settingsReady = loadSettings();
loadDictionary().catch((err) => console.error('Could not load CC-CEDICT', err));
settingsReady.then(() => {
  checkClipboard();
  setInterval(checkClipboard, CLIPBOARD_POLL_MS);
});
