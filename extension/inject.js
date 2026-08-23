// Runs in the page's main world at document_start.
// Second line of defence behind declarativeNetRequest: if Google ever moves the
// AI Overview endpoint, the network-layer rules stop matching but these do,
// because they match on the request the page itself constructs.
(() => {
  const AIO = [
    /\/async\/aion/i,
    /[?&]asearch=arc/i,
    /[?&]async=arc_id/i,
    /[?&]udm=50\b/i,
  ];
  const isAIO = (url) => {
    try { return AIO.some((re) => re.test(String(url))); } catch { return false; }
  };

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (isAIO(url)) {
      // Resolve rather than reject: a rejected promise makes Google's own code
      // throw, which in some builds triggers a full re-render of #center_col
      // and wipes the panel we injected.
      return Promise.resolve(new Response("", { status: 204 }));
    }
    return nativeFetch.apply(this, arguments);
  };

  const open_ = XMLHttpRequest.prototype.open;
  const send_ = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__claudeBlocked = isAIO(url);
    return open_.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__claudeBlocked) {
      // Fire a benign empty completion so page code that awaits it settles.
      Object.defineProperty(this, "readyState", { value: 4, configurable: true });
      Object.defineProperty(this, "status", { value: 204, configurable: true });
      Object.defineProperty(this, "responseText", { value: "", configurable: true });
      setTimeout(() => {
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      }, 0);
      return;
    }
    return send_.apply(this, arguments);
  };
})();
