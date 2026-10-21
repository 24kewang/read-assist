// Gemini API client: prompts, streaming request and section parsing.
//
// Answers come back as plain text split into sections, so they can be
// rendered while they stream:
//   @@entries
//   银行 | yínháng | n. | 存钱、取钱的地方 | bank
//   @@explanation
//   ...

export const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM = `你是一位耐心的中文老师，帮助正在学习中文的英语母语者阅读中文文本。
回答必须准确。"简单"的中文内容要用 HSK 3–4 水平的简单词语和短句。
拼音使用带声调符号的格式（例如 nǐ hǎo）。

输出格式（严格遵守）：
- 只输出要求的部分，按要求的顺序。每个部分以单独一行 "@@部分名" 开头（部分名用给定的英文名）。
- 需要多个字段的行，用 " | " 分隔字段，一行一条，不要编号或项目符号。
- 不要使用 Markdown、代码块或额外说明。`;

function contextLine(text, context) {
  return context && context !== text
    ? `上下文：「${context}」\n请根据上下文判断它在这里的意思。\n`
    : '';
}

const PROMPTS = {
  word: {
    primary: (text, context) => `学生选中了：「${text}」
${contextLine(text, context)}
@@entries
把选中的内容拆成有意义的词（本身是一个词就只写一行）。每行格式：
词 | 拼音 | 词性（英文缩写，如 n. / v. / adj.） | 简单中文释义 | 简短英文释义
@@explanation
用中文更深入地解释它的含义、用法和细微差别（2–4 句）。${context ? '说明它在上下文中的具体意思。' : ''}`,
    secondary: (text, context) => `学生选中了：「${text}」
${contextLine(text, context)}
@@examples
3 个自然、常用的例句，每行格式：
中文例句 | 拼音 | English translation
@@usage
常见搭配、近义词辨析或使用时要注意的地方（简短，中文）。`
  },
  passage: {
    primary: (text, context) => `学生选中了这段文字：
「${text}」
${contextLine(text, context)}
@@translation
自然、准确的英文翻译。
@@explanation
用中文深入解读这段文字：它真正想表达什么、语气和态度、言外之意、写作手法或逻辑结构（3–6 句）。
@@paraphrase
用简单中文把这段话的意思重新说一遍。`,
    secondary: (text, context) => `学生选中了这段文字：
「${text}」
${contextLine(text, context)}
@@vocab
段落中对学习者最重要或最难的 3–8 个词，每行格式：
词 | 拼音 | English
@@notes
值得注意的语法结构、成语、典故或文化背景（中文）。没有的话这一部分留空。`
  }
};

export function buildPrompts(mode, text, context) {
  const p = PROMPTS[mode];
  return { primary: p.primary(text, context), secondary: p.secondary(text, context) };
}

// Thinking adds seconds before the first token; keep it minimal for lookups.
function thinkingConfig(model) {
  const m = model.toLowerCase();
  if (/^gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/.test(m)) return { thinkingBudget: 128 };
  if (/^gemini-3/.test(m)) return { thinkingLevel: 'low' };
  return null;
}

function requestBody(prompt, thinking) {
  const generationConfig = { temperature: 0.3 };
  if (thinking) generationConfig.thinkingConfig = thinking;
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig
  };
}

export class GeminiError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

async function errorFor(res, model) {
  let detail = '';
  try { detail = (await res.json())?.error?.message || ''; } catch {}
  if ((res.status === 400 && /api key/i.test(detail)) || res.status === 401 || res.status === 403) {
    return new GeminiError('Gemini rejected the API key. Check it in Settings.');
  }
  if (res.status === 404) {
    return new GeminiError(`Model "${model}" was not found. Change the model in Settings.`);
  }
  if (res.status === 429) {
    return new GeminiError('Rate limited by Gemini.', { rateLimited: true });
  }
  const err = new GeminiError(`Gemini error ${res.status}${detail ? `: ${detail}` : ''}`);
  err.detail = detail;
  err.status = res.status;
  return err;
}

async function post(model, apiKey, prompt, thinking, signal) {
  return fetch(`${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(requestBody(prompt, thinking)),
    signal
  });
}

const BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER']);

// Yields the accumulated answer text after each streamed chunk.
export async function* streamGemini({ apiKey, model, prompt, signal }) {
  if (!apiKey) throw new GeminiError('No Gemini API key set. Open Settings to add one.');
  model = model || DEFAULT_MODEL;

  const thinking = thinkingConfig(model);
  let res = await post(model, apiKey, prompt, thinking, signal);
  if (!res.ok) {
    const err = await errorFor(res, model);
    // Older or unknown models may reject thinkingConfig; retry without it.
    if (!(thinking && err.status === 400 && /think/i.test(err.detail || ''))) throw err;
    res = await post(model, apiKey, prompt, null, signal);
    if (!res.ok) throw await errorFor(res, model);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason = '';

  const handleEvent = (line) => {
    if (!line.startsWith('data:')) return false;
    let data;
    try { data = JSON.parse(line.slice(5)); } catch { return false; }
    if (data.error) throw new GeminiError(`Gemini error: ${data.error.message || 'unknown'}`);
    const cand = data.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    if (data.promptFeedback?.blockReason) finishReason = data.promptFeedback.blockReason;
    const piece = cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || '').join('') || '';
    text += piece;
    return !!piece;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop();
    let changed = false;
    for (const line of lines) changed = handleEvent(line.trim()) || changed;
    if (changed) yield text;
    if (done) break;
  }

  if (!text) throw new GeminiError(`Gemini returned no answer (${finishReason || 'empty response'}).`);
  if (BLOCKED.has(finishReason)) throw new GeminiError(`Gemini stopped early (${finishReason}).`);
}

// Splits (possibly partial) answer text into { sectionName: rawText }.
export function parseSections(text) {
  const sections = {};
  let current = null;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const isLast = i === lines.length - 1;
    const header = line.match(/^\s*@@\s*([a-zA-Z]+)\s*$/);
    if (header && !isLast) {
      current = header[1].toLowerCase();
      sections[current] = '';
      return;
    }
    if (/^\s*@/.test(line) && isLast) return; // header still arriving
    if (/^\s*```/.test(line) || !current) return;
    sections[current] += (sections[current] ? '\n' : '') + line;
  });
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

// Splits a section into rows of " | "-separated fields.
export function parseRows(raw) {
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
    .map((l) => l.split(/\s*[|｜]\s*/));
}
