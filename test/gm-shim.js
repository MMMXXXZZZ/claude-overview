// Minimal stand-in for a userscript manager, so claude-overview.user.js can be
// exercised in a normal page. Implements the GM_* surface the script uses:
// synchronous value store, addStyle, menu commands, and a streaming
// GM_xmlhttpRequest built on fetch.
(() => {
  const KEY = window.__KEY__ || "";
  const BUFFERED = new URLSearchParams(location.search).get("buffered") === "1";

  window.GM_getValue = (k, d) => {
    // The API key comes from the gitignored local file, not the value store.
    if (k === "apiKey") return KEY;
    try {
      const v = localStorage.getItem("gm:" + k);
      return v === null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  };
  window.GM_setValue = (k, v) => {
    try {
      localStorage.setItem("gm:" + k, JSON.stringify(v));
    } catch (e) {
      /* ignore */
    }
  };
  window.GM_addStyle = (css) => {
    const s = document.createElement("style");
    s.textContent = css;
    (document.head || document.documentElement).append(s);
    return s;
  };
  window.GM_registerMenuCommand = (label, fn) => {
    (window.__menu__ = window.__menu__ || []).push({ label, fn });
  };

  // Tampermonkey/Violentmonkey deliver the body incrementally via onprogress
  // with a growing responseText; reproduce that shape over fetch streaming.
  window.GM_xmlhttpRequest = (o) => {
    const ctrl = new AbortController();
    (async () => {
      let res;
      try {
        res = await fetch(o.url, {
          method: o.method || "GET",
          headers: o.headers || {},
          body: o.data,
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e.name === "AbortError") return o.onabort && o.onabort();
        return o.onerror && o.onerror({ error: e.message });
      }
      const rd = res.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        let chunk;
        try {
          chunk = await rd.read();
        } catch (e) {
          if (e.name === "AbortError") return o.onabort && o.onabort();
          return o.onerror && o.onerror({ error: e.message });
        }
        if (chunk.done) break;
        text += dec.decode(chunk.value, { stream: true });
        // ?buffered=1 reproduces Tampermonkey-on-Firefox, which does not grow
        // responseText during onprogress and delivers everything at onload.
        if (!BUFFERED) o.onprogress && o.onprogress({ status: res.status, responseText: text });
      }
      o.onload && o.onload({ status: res.status, responseText: text });
    })();
    return { abort: () => ctrl.abort() };
  };
})();
