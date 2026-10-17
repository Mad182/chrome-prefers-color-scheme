(() => {
  const EVENT_TO_MAIN = '__chrome_prefers_color_scheme_set__';
  const EVENT_FROM_MAIN = '__chrome_prefers_color_scheme_req__';

  function sendModeToMain(mode) {
    if (mode !== 'dark' && mode !== 'light') return;
    try {
      document.documentElement?.setAttribute('data-chrome-prefers-scheme', mode);
    } catch (_) {}
    window.dispatchEvent(new CustomEvent(EVENT_TO_MAIN, { detail: { mode } }));
  }

  // Read stored mode immediately
  chrome.storage.local.get({ mode: 'dark' }, (data) => {
    const mode = data?.mode === 'light' ? 'light' : 'dark';
    sendModeToMain(mode);
  });

  // Listen for storage updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.mode?.newValue) {
      sendModeToMain(changes.mode.newValue);
    }
  });

  // Listen for direct tab messages from background service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PREFERS_COLOR_SCHEME_CHANGE' && msg.mode) {
      sendModeToMain(msg.mode);
    }
  });

  // Listen for CORS stylesheet fetch requests from MAIN world content script
  window.addEventListener(EVENT_FROM_MAIN, (e) => {
    const detail = e.detail;
    if (!detail || detail.type !== 'FETCH_CORS_CSS' || !detail.url || !detail.reqId) return;
    chrome.runtime.sendMessage({ type: 'FETCH_CORS_CSS', url: detail.url }, (res) => {
      window.dispatchEvent(
        new CustomEvent(EVENT_TO_MAIN, {
          detail: {
            type: 'CORS_CSS_RESULT',
            reqId: detail.reqId,
            cssText: res?.ok ? res.cssText : ''
          }
        })
      );
    });
  });
})();
