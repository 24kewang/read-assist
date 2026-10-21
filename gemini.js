// Gemini API client: prompts, response schemas and the request itself.

export const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const S = { type: 'STRING' };
const obj = (properties) => ({
  type: 'OBJECT',
  properties,
  required: Object.keys(properties)
});
const arr = (items) => ({ type: 'ARRAY', items });

const SCHEMAS = {
  word: obj({
    entries: arr(obj({
      word: S,
      pinyin: S,
      partOfSpeech: S,
      simpleDefinitionZh: S,
      english: S
    })),
    explanationZh: S,
    examples: arr(obj({ zh: S, pinyin: S, en: S })),
    usageNotesZh: S
  }),
  passage: obj({
    translationEn: S,
    simpleParaphraseZh: S,
    explanationZh: S,
    keyVocab: arr(obj({ word: S, pinyin: S, english: S })),
    culturalOrGrammarNotesZh: S
  })
};

const SYSTEM = `你是一位耐心的中文老师，帮助正在学习中文的英语母语者阅读中文文本。
回答必须准确。"简单"的中文字段要用 HSK 3–4 水平的简单词语和短句。
拼音使用带声调符号的格式（例如 nǐ hǎo）。`;

function wordPrompt(text, context) {
  return `学生选中了这个词语或短语：「${text}」
${context ? `它出现在这段上下文中：「${context}」\n请根据上下文判断它在这里的意思。` : ''}
请提供：
- entries：把选中的内容拆成有意义的词（如果本身就是一个词，只给一条）。每条包括 pinyin、partOfSpeech（英文缩写，如 n. / v. / adj.）、simpleDefinitionZh（用简单中文解释）、english（简短英文释义）。
- explanationZh：用中文更深入地解释这个词的含义、用法和细微差别（2–4 句）。${context ? '说明它在上下文中的具体意思。' : ''}
- examples：3 个自然、常用的例句，每个包括 zh、pinyin、en。
- usageNotesZh：常见搭配、近义词辨析或使用时要注意的地方（简短，中文）。`;
}

function passagePrompt(text, context) {
  return `学生选中了这段文字：
「${text}」
${context && context !== text ? `周围的上下文：「${context}」\n` : ''}
请提供：
- translationEn：自然、准确的英文翻译。
- simpleParaphraseZh：用简单中文把这段话的意思重新说一遍。
- explanationZh：用中文深入解读这段文字：它真正想表达什么、语气和态度、言外之意、写作手法或逻辑结构（3–6 句）。
- keyVocab：段落中对学习者最重要或最难的 3–8 个词，每个包括 word、pinyin、english。
- culturalOrGrammarNotesZh：值得注意的语法结构、成语、典故或文化背景（中文，没有就写空字符串）。`;
}

export function buildRequest(mode, text, context) {
  const prompt = mode === 'word' ? wordPrompt(text, context) : passagePrompt(text, context);
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: SCHEMAS[mode],
      temperature: 0.3
    }
  };
}

export class GeminiError extends Error {}

export async function callGemini({ apiKey, model, mode, text, context, signal }) {
  if (!apiKey) throw new GeminiError('No Gemini API key set. Open Settings to add one.');
  const res = await fetch(
    `${API_BASE}/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(buildRequest(mode, text, context)),
      signal
    }
  );

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    if ((res.status === 400 && /api key/i.test(detail)) || res.status === 401 || res.status === 403) {
      throw new GeminiError('Gemini rejected the API key. Check it in Settings.');
    }
    if (res.status === 404) {
      throw new GeminiError(`Model "${model}" was not found. Change the model in Settings.`);
    }
    if (res.status === 429) {
      throw new GeminiError('Rate limited by Gemini. Wait a moment and try again.');
    }
    throw new GeminiError(`Gemini error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const raw = candidate?.content?.parts?.map((p) => p.text || '').join('');
  if (!raw) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || 'empty response';
    throw new GeminiError(`Gemini returned no answer (${reason}).`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new GeminiError('Could not parse Gemini’s answer. Try again.');
  }
}
