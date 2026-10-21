// Offline CC-CEDICT lookup (data/cedict.tsv.gz, built by
// scripts/build-cedict.mjs). Gives instant definitions while Gemini works.

const MAX_WORD = 8;
const MAX_ENTRIES = 6;
const MAX_DEFS = 6;
const MAX_PHRASE_WORDS = 60;

let ready = null;

export function loadDictionary() {
  ready ??= (async () => {
    const res = await fetch(chrome.runtime.getURL('data/cedict.tsv.gz'));
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const index = new Map();
    const add = (key, entry) => {
      const list = index.get(key);
      if (!list) index.set(key, [entry]);
      else if (!list.includes(entry)) list.push(entry);
    };
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [trad, simp, pinyin, defs] = line.split('\t');
      const entry = { trad, simp, pinyin, defs: defs.split('/').filter(Boolean) };
      add(simp, entry);
      add(trad, entry);
    }
    return index;
  })();
  return ready;
}

// --- Numbered pinyin -> tone marks ("lu:e4" -> "lüè")
const MARKS = {
  a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ',
  A: 'ĀÁǍÀ', E: 'ĒÉĚÈ', O: 'ŌÓǑÒ'
};

function markSyllable(syl) {
  const m = syl.match(/^([a-zA-Zü:]+)([1-5])$/);
  if (!m) return syl.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  let [, base, tone] = m;
  base = base.replace(/u:/g, 'ü').replace(/U:/g, 'Ü');
  if (tone === '5') return base;
  const t = Number(tone) - 1;
  let idx = base.search(/[aeAE]/);
  if (idx === -1) idx = base.search(/ou|OU|Ou/);
  if (idx === -1) {
    for (let i = base.length - 1; i >= 0; i--) {
      if ('aeiouüAEIOUÜ'.includes(base[i])) { idx = i; break; }
    }
  }
  if (idx === -1) return base;
  const ch = base[idx];
  const marked = MARKS[ch]?.[t] ?? MARKS[ch.toLowerCase()]?.[t]?.toUpperCase() ?? ch;
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}

export function formatPinyin(pinyin, toneType = 'symbol') {
  if (toneType === 'num') return pinyin.replace(/u:/g, 'ü');
  return pinyin.split(' ').map(markSyllable).join(' ');
}

// Definitions also cite pinyin like 得[de2]; mark those too.
function formatDef(def, toneType) {
  return toneType === 'num'
    ? def
    : def.replace(/\[([a-zA-Z:1-5 ]+)\]/g, (_, p) => `[${formatPinyin(p, toneType)}]`);
}

const isVariantOnly = (e) => e.defs.every((d) => /variant of|^see [^\s]+\[|^old \w+ of/i.test(d));
const isNameOnly = (e) =>
  /^[A-Z]/.test(e.pinyin) || e.defs.every((d) => /^(surname |used in )/i.test(d));

// Best entries for a word: native-script matches first, then common
// readings before proper nouns, with bare "variant of" entries dropped.
function entriesFor(index, word) {
  const all = index.get(word) || [];
  const useful = all.filter((e) => !isVariantOnly(e));
  const list = useful.length ? useful : all;
  const rank = (e) =>
    (e.simp === word && e.trad === word ? 0 : e.simp === word ? 1 : 2) * 2 +
    (isNameOnly(e) ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_ENTRIES);
}

// Splits text into dictionary words by greedy longest match.
function segment(index, text) {
  const chars = Array.from(text);
  const words = [];
  for (let i = 0; i < chars.length;) {
    let len = Math.min(MAX_WORD, chars.length - i);
    while (len > 1 && !index.has(chars.slice(i, i + len).join(''))) len--;
    const word = chars.slice(i, i + len).join('');
    if (index.has(word)) words.push(word);
    i += len;
  }
  return words;
}

// Returns [{ word, pinyin, defs: [...] }] or [] if nothing matched.
export async function lookupWord(text, toneType) {
  const index = await loadDictionary();
  const clean = text.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, '');
  if (!clean) return [];
  const words = index.has(clean)
    ? [clean]
    : [...new Set(segment(index, clean))].slice(0, MAX_PHRASE_WORDS);
  const perWord = words.length > 1 ? 2 : MAX_ENTRIES;
  return words.flatMap((w) => {
    let entries = entriesFor(index, w);
    // In a multi-word phrase, surnames and names are rarely what's meant.
    if (words.length > 1 && entries.some((e) => !isNameOnly(e))) entries = entries.filter((e) => !isNameOnly(e));
    return entries.slice(0, perWord).map((e) => ({
      word: w,
      pinyin: formatPinyin(e.pinyin, toneType),
      defs: e.defs.slice(0, MAX_DEFS).map((d) => formatDef(d, toneType))
    }));
  });
}
