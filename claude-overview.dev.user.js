// ==UserScript==
// @name         Claude Overview (dev loader)
// @namespace    claude-overview-dev
// @version      1.0.0
// @description  Thin loader — pulls the real script from the local dev server so edits take effect on reload, with no reinstall.
// @match        https://www.google.com/search*
// @include      /^https:\/\/www\.google\.[a-z]{2,3}(\.[a-z]{2})?\/search[?\/]/
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM.getValue
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM.registerMenuCommand
// @connect      api.anthropic.com
// @connect      wsrv.nl
// @noframes
// @require      http://127.0.0.1:8777/claude-overview.user.js
// ==/UserScript==

/* Install THIS file in Tampermonkey, not claude-overview.user.js.

   Firefox extensions cannot read file:// URLs, so the script is served over
   HTTP instead. Start the server first, from the repo root:

       node dev-server.mjs

   It serves this directory on 127.0.0.1:8777 with `Cache-Control: no-store`,
   which matters: Tampermonkey caches @require resources, and a cached copy
   means you keep running the previous version after every edit. If it still
   feels stale, set Tampermonkey → Settings → Config mode "Advanced" →
   Externals → "Update Interval" to Always, then reload the page.

   The @require'd file's own ==UserScript== block is ignored (it is read as
   plain JS), which is why every @grant, @connect, @match and @run-at has to be
   declared here instead — a missing @grant shows up as GM_xmlhttpRequest being
   undefined at runtime, not as an install error.

   With the server down the @require fails and no panel appears; that is the
   expected failure mode, not a bug in the script.

   Values (API key, history, settings) live under THIS script's storage entry,
   separately from the standalone install — so if you switch between them,
   expect to re-enter the key once.

   For normal use install claude-overview.user.js directly; it is self-contained
   and needs no server. */
