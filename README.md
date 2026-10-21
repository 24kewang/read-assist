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
| PDFs (Chrome's PDF viewer) | Select the text, press <kbd>Ctrl</kbd>+<kbd>C</kbd>, then <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> (or click 📋 in the sidebar). |
| Google Docs | Select and press <kbd>Ctrl</kbd>+<kbd>C</kbd>. The sidebar reads the clipboard automatically; if not, use <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> or 📋. |
| Anything else | Type or paste into the box at the bottom of the sidebar. |

The **Auto / Word / Passage** toggle overrides the automatic choice. Auto treats up to 6 Chinese characters with no sentence punctuation as a word lookup.

To change the shortcut, open `chrome://extensions/shortcuts`.

## Settings

- **Model**: defaults to `gemini-2.5-flash`. Any Gemini model that supports JSON output works.
- **Pinyin tones**: tone marks (nǐ hǎo) or numbers (ni3 hao3).

## Notes

- Selections are sent only to Google's Gemini API, using your key, and only while the sidebar is open. Some surrounding text from the page is sent too, so the model can choose the right meaning.
- The pinyin above the selection comes from [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (MIT, vendored in `lib/`). It is very good but can miss rare readings of polyphonic characters. The pinyin in the definition cards comes from the model.

## Files

- `manifest.json`: MV3 manifest
- `background.js`: opens the side panel and tracks whether it is open (on/off state)
- `content.js`: detects Chinese selections on pages
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js`: the sidebar UI
- `gemini.js`: prompts, response schemas and the API call
- `options.html`, `options.js`: settings page
