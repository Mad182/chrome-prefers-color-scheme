const SCRIPT_ID = 'prefers-color-scheme-sync-init';

async function getMode() {
  const data = await chrome.storage.local.get({ mode: 'dark' });
  return data.mode === 'light' ? 'light' : 'dark';
}

async function updateActionUI(mode) {
  const nextMode = mode === 'dark' ? 'light' : 'dark';
  await chrome.action.setIcon({
    path: {
      16: `icons/${mode}16.png`,
      32: `icons/${mode}32.png`,
      48: `icons/${mode}48.png`,
      128: `icons/${mode}128.png`
    }
  });
  await chrome.action.setTitle({
    title: `prefers-color-scheme: ${mode} (Click to switch to ${nextMode})`
  });
}

async function syncRegisteredScript(mode) {
  const jsFile = mode === 'light' ? 'mode-light.js' : 'mode-dark.js';
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length > 0) {
      await chrome.scripting.updateContentScripts([
        {
          id: SCRIPT_ID,
          matches: ['<all_urls>'],
          js: [jsFile],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true
        }
      ]);
    } else {
      await chrome.scripting.registerContentScripts([
        {
          id: SCRIPT_ID,
          matches: ['<all_urls>'],
          js: [jsFile],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true
        }
      ]);
    }
  } catch (err) {
    console.warn('Failed to register sync content script:', err);
  }
}

async function broadcastModeToTabs(mode) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(tab.url)) {
      continue;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'PREFERS_COLOR_SCHEME_CHANGE', mode }).catch(() => {});
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: (newMode) => {
        window.__CHROME_PREFERS_COLOR_SCHEME__ = newMode;
        if (typeof window.__setChromePrefersColorScheme === 'function') {
          window.__setChromePrefersColorScheme(newMode);
        }
      },
      args: [mode]
    }).catch(() => {});
  }
}

async function applyMode(mode, notifyTabs = false) {
  await updateActionUI(mode);
  await syncRegisteredScript(mode);
  if (notifyTabs) {
    await broadcastModeToTabs(mode);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const mode = await getMode();
  await chrome.storage.local.set({ mode });
  await applyMode(mode, true);
});

chrome.runtime.onStartup.addListener(async () => {
  const mode = await getMode();
  await applyMode(mode, false);
});

// Single top-bar button click handler: toggles between dark and light mode
chrome.action.onClicked.addListener(async () => {
  const current = await getMode();
  const next = current === 'dark' ? 'light' : 'dark';
  await chrome.storage.local.set({ mode: next });
  await applyMode(next, true);
});

// Handle messages from isolated content script (e.g., initial mode sync or CORS stylesheet fetch)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'GET_PREFERS_COLOR_SCHEME') {
    getMode().then((mode) => sendResponse({ mode }));
    return true;
  }

  if (msg.type === 'FETCH_CORS_CSS' && msg.url) {
    fetch(msg.url, { credentials: 'omit' })
      .then((res) => (res.ok ? res.text() : ''))
      .then((cssText) => sendResponse({ ok: true, cssText }))
      .catch(() => sendResponse({ ok: false, cssText: '' }));
    return true;
  }

  return false;
});

// Ensure UI and registered script are initialized whenever service worker wakes up
getMode().then((mode) => applyMode(mode, false));
