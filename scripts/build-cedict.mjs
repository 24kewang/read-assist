// Converts the official CC-CEDICT file (cedict_ts.u8, from
// https://www.mdbg.net/chinese/dictionary?page=cc-cedict) into the compact
// gzipped TSV the side panel loads: trad \t simp \t pinyin \t def1/def2/...
//
//   node scripts/build-cedict.mjs path/to/cedict_ts.u8
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-cedict.mjs cedict_ts.u8');
  process.exit(1);
}

const LINE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;
const header = [];
const rows = [];
for (const line of readFileSync(src, 'utf8').split('\n')) {
  if (line.startsWith('#')) {
    if (/^#! (version|date|publisher|license)/.test(line)) header.push(line);
    continue;
  }
  const m = line.match(LINE);
  if (!m) continue;
  const [, trad, simp, pinyin, defs] = m;
  rows.push([trad, simp, pinyin, defs].join('\t'));
}

const out = [...header, ...rows].join('\n') + '\n';
writeFileSync(new URL('../data/cedict.tsv.gz', import.meta.url), gzipSync(out, { level: 9 }));
console.log(`${rows.length} entries`);
