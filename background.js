// Service worker: opens the side panel from the toolbar icon and tracks
// whether the panel is open. Content scripts only send selections while
// `active` is true in chrome.storage.session.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// storage.session is not exposed to content scripts by default.
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
});

const panelPorts = new Set();

function setActive(active) {
  chrome.storage.session.set({ active });
}

// A worker restart drops every port, so start from "inactive"; an open
// panel reconnects on its own and flips this back.
setActive(false);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);
  setActive(true);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    if (panelPorts.size === 0) setActive(false);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'lookup-clipboard') {
    for (const port of panelPorts) port.postMessage({ type: 'read-clipboard' });
  }
});
