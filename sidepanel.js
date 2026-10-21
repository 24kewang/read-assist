import { callGemini, DEFAULT_MODEL } from './gemini.js';

const CJK = /[㐀-鿿豈-﫿]/;
const CJK_ALL = /[㐀-鿿豈-﫿]/g;
const SENTENCE_PUNCT = /[。！？；，、：,.!?;:]/;
const WORD_MAX_CHARS = 6;
const CACHE_LIMIT = 100;

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

let settings = { apiKey: '', model: DEFAULT_MODEL, toneType: 'symbol' };
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
  else if (msg.type === 'read-clipboard') lookupClipboard();
});

// --- Settings
async function loadSettings() {
  const s = await chrome.storage.local.get(['apiKey', 'model', 'toneType']);
  settings = {
    apiKey: s.apiKey || '',
    model: s.model || DEFAULT_MODEL,
    toneType: s.toneType || 'symbol'
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

function card(title, ...body) {
  return el('section', { class: 'card' }, el('h3', {}, title), ...body);
}

const para = (text, cls = '', lang = 'zh') => text ? el('p', { class: cls, lang }, text) : null;

// --- Result rendering
function renderWord(r) {
  const entries = (r.entries || []).map((e) =>
    el('div', { class: 'entry' },
      el('div', { class: 'entry-head' },
        el('span', { class: 'entry-word', lang: 'zh' }, e.word),
        el('span', { class: 'entry-pinyin' }, e.pinyin),
        e.partOfSpeech ? el('span', { class: 'pos' }, e.partOfSpeech) : null),
      para(e.simpleDefinitionZh),
      para(e.english, 'entry-en', 'en')));

  const examples = (r.examples || []).map((x) =>
    el('li', {},
      el('div', { lang: 'zh' }, x.zh),
      el('div', { class: 'ex-pinyin' }, x.pinyin),
      el('div', { class: 'ex-en', lang: 'en' }, x.en)));

  ui.results.replaceChildren(
    card('释义 · Definition', entries),
    r.explanationZh ? card('深入解释 · Explanation', para(r.explanationZh)) : '',
    examples.length ? card('例句 · Examples', el('ul', { class: 'examples' }, examples)) : '',
    r.usageNotesZh ? card('用法 · Usage notes', para(r.usageNotesZh)) : ''
  );
}

function renderPassage(r) {
  const vocab = (r.keyVocab || []).map((v) =>
    el('tr', {},
      el('td', { lang: 'zh' }, v.word),
      el('td', {}, v.pinyin),
      el('td', { lang: 'en' }, v.english)));

  ui.results.replaceChildren(
    card('English', para(r.translationEn, 'big-en', 'en')),
    r.simpleParaphraseZh ? card('简单地说 · In simple Chinese', para(r.simpleParaphraseZh)) : '',
    r.explanationZh ? card('深入解读 · Deeper meaning', para(r.explanationZh)) : '',
    vocab.length ? card('重点词语 · Key vocabulary', el('table', { class: 'vocab' }, vocab)) : '',
    r.culturalOrGrammarNotesZh ? card('语法与文化 · Notes', para(r.culturalOrGrammarNotesZh)) : ''
  );
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

async function run() {
  await settingsReady;
  if (!current) return;
  const { text, context } = current;
  const mode = effectiveMode(text);
  ui.modeLabel.textContent = modeOverride === 'auto' ? `detected: ${mode}` : '';

  inflight?.abort();
  ui.results.replaceChildren();

  if (!settings.apiKey) {
    const frag = document.createDocumentFragment();
    frag.append('Add your Gemini API key in ', openSettingsLink('Settings'), ' to see definitions and explanations.');
    setStatus(frag, { error: true });
    return;
  }

  const key = `${settings.model}|${mode}|${text}|${context}`;
  const render = mode === 'word' ? renderWord : renderPassage;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    setStatus('');
    render(hit);
    return;
  }

  const controller = new AbortController();
  inflight = controller;
  setStatus(mode === 'word' ? 'Looking up…' : 'Reading the passage…', { loading: true });
  try {
    const result = await callGemini({
      apiKey: settings.apiKey,
      model: settings.model,
      mode,
      text,
      context,
      signal: controller.signal
    });
    if (controller.signal.aborted) return;
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    setStatus('');
    render(result);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(err.message || String(err), { error: true });
  } finally {
    if (inflight === controller) inflight = null;
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

async function lookupClipboard() {
  const text = (await readClipboard()).trim();
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
