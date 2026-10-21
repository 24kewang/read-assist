# 读 Read Assist

A Chrome extension for reading Chinese. Open the sidebar, select Chinese text on any page, and the sidebar shows:

- the text with **pinyin** above each character, generated instantly and locally
- for **a few characters**: a simple Chinese definition (简单中文), an English gloss, a deeper explanation, example sentences and usage notes
- for **a sentence or passage**: an English translation, a simple Chinese paraphrase, a deeper reading of the meaning (深入解读), key vocabulary, and grammar or cultural notes

The extension is only active while the sidebar is open. Close the sidebar with its **X** to turn it off.

## Install

1. Get a Gemini API key at <https://aistudio.google.com/apikey>.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose this folder.
3. Pin the extension and click its icon to open the sidebar.
4. Click ⚙︎ in the sidebar (or open the extension's Options), paste your key, and save.

## Usage

| Where | How |
|---|---|
| Ordinary web pages | Just select text. The sidebar updates automatically. |
| PDFs and Google Docs | Select the text and press <kbd>Ctrl</kbd>+<kbd>C</kbd>. The sidebar picks it up from the clipboard automatically. |
| Re-run a lookup | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or 📋 looks up whatever is on the clipboard. |
| Anything else | Type or paste into the box at the bottom of the sidebar. |

The **Auto / Word / Passage** toggle overrides the automatic choice. Auto treats up to 6 Chinese characters with no sentence punctuation as a word lookup.

To change the shortcut, open `chrome://extensions/shortcuts`.

## Settings

- **Model**: defaults to `gemini-2.5-flash`. Any Gemini model that supports JSON output works.
- **Pinyin tones**: tone marks (nǐ hǎo) or numbers (ni3 hao3).

## Speed

For short selections, the **Definition** card fills instantly from the bundled CC-CEDICT dictionary (English definitions, works offline and without an API key). Gemini's definition, which adds part of speech and a simple-Chinese explanation, is fetched at the same time. It replaces the dictionary entry only once it has fully arrived.

Answers stream into the sidebar as they're generated. Each lookup sends **two requests to Gemini in parallel**:
- the priority one: the definition and explanation (or, for passages, the translation, deeper meaning and simple paraphrase)
- the extras: examples and usage notes, or key vocabulary and notes

"Thinking" is turned down for supported models so the first words arrive quickly. Lookups you've already done are cached for the session. On the free tier's per-minute limit, the extras card may say "Rate limited"; click **Retry**.

## Notes

- While the sidebar is open, it checks the clipboard about once a second to catch <kbd>Ctrl</kbd>+<kbd>C</kbd> in PDFs, where extensions can't see the selection. Clipboard text is ignored unless it changed and contains Chinese, and whatever was on the clipboard when the sidebar opened is never looked up. You can turn this off in Settings.
- Selections are sent only to Google's Gemini API, using your key, and only while the sidebar is open. Some surrounding text from the page is sent too, so the model can choose the right meaning.
- The pinyin above the selection comes from [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (MIT, vendored in `lib/`). It is very good but can miss rare readings of polyphonic characters. The pinyin in the definition cards comes from the model.

## Files

- `manifest.json`: MV3 manifest
- `background.js`: opens the side panel and tracks whether it is open (on/off state)
- `content.js`: detects Chinese selections on pages
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`: the sidebar UI
- `gemini.js`: prompts, streaming API call and the section parser
- `options.html`, `options.js`: settings page
- `cedict.js`: offline dictionary lookup and pinyin formatting
- `data/cedict.tsv.gz`: CC-CEDICT, prebuilt by `scripts/build-cedict.mjs`

## Updating the dictionary

Download `cedict_1_0_ts_utf-8_mdbg.zip` from [MDBG](https://www.mdbg.net/chinese/dictionary?page=cc-cedict), unzip it, and run:

```
node scripts/build-cedict.mjs path/to/cedict_ts.u8
```

The bundled copy is CC-CEDICT as of January 2026.

## Credits

- [CC-CEDICT](https://cc-cedict.org/) by MDBG, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). `data/cedict.tsv.gz` is a reformatted copy and is under the same license.
- [pinyin-pro](https://github.com/zh-lx/pinyin-pro), MIT.
