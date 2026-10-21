import { DEFAULT_MODEL } from './gemini.js';

const apiKey = document.getElementById('apiKey');
const model = document.getElementById('model');
const saved = document.getElementById('saved');

const s = await chrome.storage.local.get(['apiKey', 'model', 'toneType']);
apiKey.value = s.apiKey || '';
model.value = s.model || DEFAULT_MODEL;
document.querySelector(`input[name=toneType][value="${s.toneType || 'symbol'}"]`).checked = true;

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    apiKey: apiKey.value.trim(),
    model: model.value.trim() || DEFAULT_MODEL,
    toneType: document.querySelector('input[name=toneType]:checked').value
  });
  saved.textContent = 'Saved.';
  setTimeout(() => { saved.textContent = ''; }, 1500);
});
