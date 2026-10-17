(() => {
  if (window.__chromePrefersColorSchemeInitialized) return;
  window.__chromePrefersColorSchemeInitialized = true;

  const EVENT_TO_MAIN = '__chrome_prefers_color_scheme_set__';
  const EVENT_FROM_MAIN = '__chrome_prefers_color_scheme_req__';
  const STORAGE_CACHE_KEY = '__chrome_prefers_color_scheme_cache__';

  let currentMode = 'dark';
  try {
    const attrMode = document.documentElement?.getAttribute('data-chrome-prefers-scheme');
    const cachedMode = sessionStorage.getItem(STORAGE_CACHE_KEY) || localStorage.getItem(STORAGE_CACHE_KEY);
    if (window.__CHROME_PREFERS_COLOR_SCHEME__ === 'light' || window.__CHROME_PREFERS_COLOR_SCHEME__ === 'dark') {
      currentMode = window.__CHROME_PREFERS_COLOR_SCHEME__;
    } else if (attrMode === 'light' || attrMode === 'dark') {
      currentMode = attrMode;
    } else if (cachedMode === 'light' || cachedMode === 'dark') {
      currentMode = cachedMode;
    }
  } catch (_) {
    if (window.__CHROME_PREFERS_COLOR_SCHEME__ === 'light' || window.__CHROME_PREFERS_COLOR_SCHEME__ === 'dark') {
      currentMode = window.__CHROME_PREFERS_COLOR_SCHEME__;
    }
  }

  const nativeMatchMedia = window.matchMedia.bind(window);
  const trackedMQLs = new Set();
  const originalRuleMediaMap = new WeakMap();
  const originalRuleColorSchemeMap = new WeakMap();
  const originalElementMediaMap = new WeakMap();
  const originalMetaContentMap = new WeakMap();
  const processedCorsLinks = new WeakMap();
  const shadowRoots = new Set();
  let corsReqCounter = 0;
  const pendingCorsCallbacks = new Map();

  function rewriteMediaQuery(query, mode) {
    if (typeof query !== 'string' || !/prefers-color-scheme/i.test(query)) {
      return query;
    }
    return query.replace(
      /\(\s*prefers-color-scheme\s*:\s*(dark|light|no-preference)\s*\)/gi,
      (_, scheme) => {
        const val = scheme.toLowerCase();
        if (val === mode) {
          return '(min-width: 0px)';
        }
        return '(max-width: -1px)';
      }
    );
  }

  // 1. Override window.matchMedia
  function createEmulatedMQL(originalQuery) {
    const baseMQL = nativeMatchMedia(originalQuery);
    const normalizedMedia = baseMQL.media || String(originalQuery);
    const changeListeners = new Map();
    let onchangeHandler = null;

    const evaluateMatches = () => {
      const rewritten = rewriteMediaQuery(originalQuery, currentMode);
      return nativeMatchMedia(rewritten).matches;
    };

    let lastMatches = evaluateMatches();

    const mqlWrapper = Object.create(MediaQueryList.prototype, {
      media: {
        get() {
          return normalizedMedia;
        },
        enumerable: true,
        configurable: true
      },
      matches: {
        get() {
          return evaluateMatches();
        },
        enumerable: true,
        configurable: true
      },
      onchange: {
        get() {
          return onchangeHandler;
        },
        set(fn) {
          onchangeHandler = typeof fn === 'function' ? fn : null;
        },
        enumerable: true,
        configurable: true
      },
      addEventListener: {
        value(type, listener, options) {
          if (type === 'change' && (typeof listener === 'function' || (listener && typeof listener.handleEvent === 'function'))) {
            const once = typeof options === 'object' && options !== null ? Boolean(options.once) : false;
            changeListeners.set(listener, { once });
            if (options && typeof options === 'object' && options.signal instanceof AbortSignal) {
              options.signal.addEventListener('abort', () => changeListeners.delete(listener), { once: true });
            }
          } else {
            baseMQL.addEventListener(type, listener, options);
          }
        },
        writable: true,
        configurable: true
      },
      removeEventListener: {
        value(type, listener, options) {
          if (type === 'change') {
            changeListeners.delete(listener);
          } else {
            baseMQL.removeEventListener(type, listener, options);
          }
        },
        writable: true,
        configurable: true
      },
      addListener: {
        value(listener) {
          if (typeof listener === 'function') {
            changeListeners.set(listener, { once: false });
          }
        },
        writable: true,
        configurable: true
      },
      removeListener: {
        value(listener) {
          changeListeners.delete(listener);
        },
        writable: true,
        configurable: true
      },
      dispatchEvent: {
        value(event) {
          return baseMQL.dispatchEvent(event);
        },
        writable: true,
        configurable: true
      },
      _notifyIfChanged: {
        value() {
          const nowMatches = evaluateMatches();
          if (nowMatches === lastMatches) return;
          lastMatches = nowMatches;

          let evt;
          try {
            evt = new MediaQueryListEvent('change', {
              media: normalizedMedia,
              matches: nowMatches
            });
          } catch (_) {
            evt = new Event('change');
            Object.defineProperty(evt, 'media', { value: normalizedMedia });
            Object.defineProperty(evt, 'matches', { value: nowMatches });
          }

          if (typeof onchangeHandler === 'function') {
            try {
              onchangeHandler.call(mqlWrapper, evt);
            } catch (err) {
              console.error(err);
            }
          }

          for (const [listener, meta] of Array.from(changeListeners.entries())) {
            if (meta.once) {
              changeListeners.delete(listener);
            }
            try {
              if (typeof listener === 'function') {
                listener.call(mqlWrapper, evt);
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent(evt);
              }
            } catch (err) {
              console.error(err);
            }
          }
        }
      }
    });

    trackedMQLs.add(mqlWrapper);
    return mqlWrapper;
  }

  const overriddenMatchMedia = function matchMedia(query) {
    const qStr = String(query);
    if (/prefers-color-scheme/i.test(qStr)) {
      return createEmulatedMQL(qStr);
    }
    return nativeMatchMedia(query);
  };
  Object.defineProperty(window, 'matchMedia', {
    value: overriddenMatchMedia,
    writable: true,
    configurable: true
  });

  // 2. Rewrite CSS rules in stylesheets
  function processCSSRule(rule) {
    if (!rule) return;

    try {
      if (rule.media && typeof rule.media.mediaText === 'string') {
        const origMedia = originalRuleMediaMap.get(rule) ?? rule.media.mediaText;
        if (/prefers-color-scheme/i.test(origMedia)) {
          if (!originalRuleMediaMap.has(rule)) {
            originalRuleMediaMap.set(rule, origMedia);
          }
          const targetMedia = rewriteMediaQuery(origMedia, currentMode);
          if (rule.media.mediaText !== targetMedia) {
            rule.media.mediaText = targetMedia;
          }
        }
      }
    } catch (_) {}

    try {
      if (rule.style) {
        const saved = originalRuleColorSchemeMap.get(rule);
        const rawVal = saved ? saved.value : rule.style.getPropertyValue('color-scheme');
        if (rawVal && /\blight\b/i.test(rawVal) && /\bdark\b/i.test(rawVal)) {
          if (!saved) {
            originalRuleColorSchemeMap.set(rule, {
              value: rawVal,
              priority: rule.style.getPropertyPriority('color-scheme')
            });
          }
          const prio = originalRuleColorSchemeMap.get(rule).priority;
          rule.style.setProperty('color-scheme', currentMode, prio);
        }
      }
    } catch (_) {}

    try {
      if (rule.styleSheet) {
        processStyleSheet(rule.styleSheet);
      }
    } catch (_) {}

    try {
      if (rule.cssRules) {
        const rules = rule.cssRules;
        for (let i = 0; i < rules.length; i++) {
          processCSSRule(rules[i]);
        }
      }
    } catch (_) {}
  }

  function absolutizeCssUrls(cssText, baseHref) {
    return cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, relUrl) => {
      const trimmed = relUrl.trim();
      if (!trimmed || /^(data:|blob:|https?:|#|\/)/i.test(trimmed)) {
        return full;
      }
      try {
        const abs = new URL(trimmed, baseHref).href;
        return `url("${abs}")`;
      } catch (_) {
        return full;
      }
    });
  }

  function handleCrossOriginLink(linkEl, href) {
    if (!linkEl || processedCorsLinks.has(linkEl)) return;
    processedCorsLinks.set(linkEl, true);

    const reqId = `cors_${++corsReqCounter}`;
    pendingCorsCallbacks.set(reqId, (cssText) => {
      if (!cssText || !/prefers-color-scheme/i.test(cssText)) return;
      try {
        const resolvedCss = absolutizeCssUrls(cssText, href);
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-prefers-color-scheme-cors', href);
        styleEl.textContent = resolvedCss;
        linkEl.insertAdjacentElement('afterend', styleEl);
        linkEl.disabled = true;
        if (styleEl.sheet) {
          processStyleSheet(styleEl.sheet);
        }
      } catch (_) {}
    });

    window.dispatchEvent(
      new CustomEvent(EVENT_FROM_MAIN, {
        detail: { type: 'FETCH_CORS_CSS', url: href, reqId }
      })
    );
  }

  function processStyleSheet(sheet) {
    if (!sheet) return;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      const owner = sheet.ownerNode;
      if (owner && owner.tagName === 'LINK' && sheet.href && /^https?:/i.test(sheet.href)) {
        handleCrossOriginLink(owner, sheet.href);
      }
      return;
    }
    if (!rules) return;
    for (let i = 0; i < rules.length; i++) {
      processCSSRule(rules[i]);
    }
  }

  function processRootStyleSheets(root) {
    if (!root) return;
    try {
      const sheets = root.styleSheets;
      if (sheets) {
        for (let i = 0; i < sheets.length; i++) {
          processStyleSheet(sheets[i]);
        }
      }
    } catch (_) {}

    try {
      const adopted = root.adoptedStyleSheets;
      if (adopted) {
        for (let i = 0; i < adopted.length; i++) {
          processStyleSheet(adopted[i]);
        }
      }
    } catch (_) {}
  }

  // 3. Rewrite HTML [media] attributes (<link>, <style>, <source>) and <meta name="color-scheme">
  function processDOMElements(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const mediaEls = root.querySelectorAll('link[media], style[media], source[media]');
    for (const el of mediaEls) {
      const orig = originalElementMediaMap.get(el) ?? el.getAttribute('media');
      if (orig && /prefers-color-scheme/i.test(orig)) {
        if (!originalElementMediaMap.has(el)) {
          originalElementMediaMap.set(el, orig);
        }
        const rewritten = rewriteMediaQuery(orig, currentMode);
        if (el.getAttribute('media') !== rewritten) {
          el.setAttribute('media', rewritten);
        }
      }
    }

    const metaEls = root.querySelectorAll('meta[name="color-scheme" i]');
    for (const meta of metaEls) {
      const orig = originalMetaContentMap.get(meta) ?? meta.getAttribute('content');
      if (orig && /\blight\b/i.test(orig) && /\bdark\b/i.test(orig)) {
        if (!originalMetaContentMap.has(meta)) {
          originalMetaContentMap.set(meta, orig);
        }
        if (meta.getAttribute('content') !== currentMode) {
          meta.setAttribute('content', currentMode);
        }
      }
    }
  }

  function processAll() {
    processRootStyleSheets(document);
    processDOMElements(document);
    for (const sr of shadowRoots) {
      processRootStyleSheets(sr);
      processDOMElements(sr);
    }
  }

  // 4. Hook CSSStyleSheet methods and attachShadow for dynamic styles & Web Components
  if (typeof CSSStyleSheet !== 'undefined') {
    const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
    if (origReplaceSync) {
      CSSStyleSheet.prototype.replaceSync = function (text) {
        const res = origReplaceSync.call(this, text);
        processStyleSheet(this);
        return res;
      };
    }

    const origReplace = CSSStyleSheet.prototype.replace;
    if (origReplace) {
      CSSStyleSheet.prototype.replace = function (text) {
        return origReplace.call(this, text).then((sheet) => {
          processStyleSheet(sheet);
          return sheet;
        });
      };
    }

    const origInsertRule = CSSStyleSheet.prototype.insertRule;
    if (origInsertRule) {
      CSSStyleSheet.prototype.insertRule = function (rule, index) {
        const idx = origInsertRule.call(this, rule, index);
        try {
          processCSSRule(this.cssRules[idx]);
        } catch (_) {}
        return idx;
      };
    }
  }

  const origAttachShadow = Element.prototype.attachShadow;
  if (origAttachShadow) {
    Element.prototype.attachShadow = function (init) {
      const sr = origAttachShadow.call(this, init);
      shadowRoots.add(sr);
      observer.observe(sr, { childList: true, subtree: true, attributes: true, attributeFilter: ['media', 'content'] });
      return sr;
    };
  }

  // 5. MutationObserver to catch newly added <style>, <link>, <source>, <meta> elements immediately
  const observer = new MutationObserver((mutations) => {
    let shouldProcessSheets = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const tag = node.tagName;
          if (tag === 'STYLE' || tag === 'LINK') {
            shouldProcessSheets = true;
            if (tag === 'LINK') {
              node.addEventListener('load', () => processRootStyleSheets(document), { once: true });
            }
          }
          if (tag === 'STYLE' || tag === 'LINK' || tag === 'SOURCE' || tag === 'META' || tag === 'PICTURE') {
            processDOMElements(document);
          } else if (node.querySelector) {
            if (node.querySelector('style, link')) {
              shouldProcessSheets = true;
              for (const lnk of node.querySelectorAll('link')) {
                lnk.addEventListener('load', () => processRootStyleSheets(document), { once: true });
              }
            }
            if (node.querySelector('link[media], style[media], source[media], meta[name="color-scheme" i]')) {
              processDOMElements(document);
            }
          }
        }
      }
    }
    if (shouldProcessSheets) {
      processRootStyleSheets(document);
    }
  });

  observer.observe(document, {
    childList: true,
    subtree: true
  });

  // 6. Mode update handler
  function setMode(newMode) {
    if (newMode !== 'dark' && newMode !== 'light') return;
    const changed = newMode !== currentMode;
    currentMode = newMode;
    window.__CHROME_PREFERS_COLOR_SCHEME__ = newMode;

    try {
      sessionStorage.setItem(STORAGE_CACHE_KEY, newMode);
      localStorage.setItem(STORAGE_CACHE_KEY, newMode);
    } catch (_) {}

    processAll();

    if (changed) {
      for (const mql of trackedMQLs) {
        mql._notifyIfChanged();
      }
    }
  }

  window.__setChromePrefersColorScheme = setMode;

  window.addEventListener(EVENT_TO_MAIN, (e) => {
    const detail = e.detail;
    if (!detail) return;
    if (detail.mode === 'dark' || detail.mode === 'light') {
      setMode(detail.mode);
    } else if (detail.type === 'CORS_CSS_RESULT' && detail.reqId) {
      const cb = pendingCorsCallbacks.get(detail.reqId);
      if (cb) {
        pendingCorsCallbacks.delete(detail.reqId);
        cb(detail.cssText || '');
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', processAll, { once: true });
    window.addEventListener('load', processAll, { once: true });
  } else {
    processAll();
  }
})();
