// ==UserScript==
// @name         Claude Overview
// @namespace    claude-overview
// @version      1.3.1
// @description  Removes Google's AI Overview and replaces it with Claude (API required). Choose models, effort, and optionally answer from the page's own search results.
// @license      MIT
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
// ==/UserScript==

/* Claude Overview - MIT licensed.

   WHAT IT DOES
   Google renders its AI Overview inline in the search page, so there is no
   request to block. This script removes that block and puts an answer from
   Claude in the same slot. Optionally it forces Google's web-only results
   (udm=14), which is what actually stops Google generating an overview at all.

   WHAT IT COSTS
   You supply your own Anthropic API key and every answer is billed to it.
   Web search is on by default (about $0.01 per search on top of tokens), so a
   search-backed answer typically costs a few cents. The panel shows the cost
   of each answer and a running total for the day, estimated from the token
   counts the API reports. Turn the panel off and it spends nothing.

   WHAT LEAVES YOUR BROWSER
   - Your search query, to api.anthropic.com. That is the whole point of the
     script; the query also still goes to Google, because it is the search.
   - Your conversation, if you use the follow-up box, to api.anthropic.com.
   - Page context, ONLY if you switch it on in settings (off by default): local
     time, time zone, the locality Google prints in the page footer, and - only
     when you have ALREADY granted google.com location access - coordinates
     rounded to about 110 m. The settings dialog shows the exact text before
     you enable it. This script never raises a location permission prompt.
   - Extracts of the search results on the page, ONLY if you switch it on in
     settings (off by default): each result as Google rendered it - title,
     source, date, snippet, sitelinks - so Claude answers from the same
     evidence you can see instead of guessing. Switching it on also lets Claude
     fetch and read the pages those results point at; that fetching happens on
     Anthropic's servers, not from your browser. The settings dialog shows the
     exact text before you enable it.
   - The hostnames of your search results, to wsrv.nl, which proxies favicon
     images from icons.duckduckgo.com.
   Nothing is sent anywhere else. There is no tracking, no analytics, and
   nothing reports back to the author.

   WHERE YOUR KEY LIVES
   In your userscript manager's own storage, never in google.com's storage, and
   sent only to api.anthropic.com. The settings dialog is built inside a closed
   shadow root so scripts on the page cannot read the input field. Answers,
   conversations and history are stored locally and capped.
*/

/* Works on Violentmonkey, Tampermonkey and Greasemonkey. Everything below goes
   through the compat shim in section 0, which prefers the synchronous GM_*
   API and falls back to the promise-based GM.* one. */

(function () {
  "use strict";

  /* ---------- 0. GM compatibility shim ---------- */
  // Keys that must never leave the manager's own storage. localStorage here is
  // the google.com origin — anything written there is readable by Google's own
  // scripts and by every other extension with access to the page.
  const SECRETS = new Set(["apiKey"]);
  const hasGMStore = () =>
    typeof GM_getValue === "function" ||
    (typeof GM !== "undefined" && !!GM.getValue);

  const GM_ = {
    get(key, dflt) {
      if (typeof GM_getValue === "function") {
        return Promise.resolve(GM_getValue(key, dflt));
      }
      if (typeof GM !== "undefined" && GM.getValue) {
        return Promise.resolve(GM.getValue(key, dflt));
      }
      if (SECRETS.has(key)) return Promise.resolve(dflt); // never read a secret from the page origin
      try {
        const v = localStorage.getItem("co:" + key);
        return Promise.resolve(v === null ? dflt : JSON.parse(v));
      } catch (e) {
        return Promise.resolve(dflt);
      }
    },
    set(key, val) {
      if (typeof GM_setValue === "function") {
        return Promise.resolve(GM_setValue(key, val));
      }
      if (typeof GM !== "undefined" && GM.setValue) {
        return Promise.resolve(GM.setValue(key, val));
      }
      if (SECRETS.has(key)) {
        // Refuse rather than silently downgrade to page-visible storage.
        return Promise.reject(new Error("No userscript storage available for secrets"));
      }
      try {
        localStorage.setItem("co:" + key, JSON.stringify(val));
      } catch (e) {
        /* quota or disabled storage */
      }
      return Promise.resolve();
    },
    // GM_xmlhttpRequest is the only way to reach api.anthropic.com: a plain
    // fetch() from the page is subject to Google's connect-src CSP.
    xhr(opts) {
      if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(opts);
      if (typeof GM !== "undefined" && GM.xmlHttpRequest) {
        return GM.xmlHttpRequest(opts);
      }
      opts.onerror && opts.onerror({ error: "No GM_xmlhttpRequest available" });
      return null;
    },
    style(css) {
      if (typeof GM_addStyle === "function") return GM_addStyle(css);
      const s = document.createElement("style");
      s.textContent = css;
      (document.head || document.documentElement).append(s);
      return s;
    },
    menu(label, fn) {
      try {
        if (typeof GM_registerMenuCommand === "function") {
          GM_registerMenuCommand(label, fn);
        } else if (typeof GM !== "undefined" && GM.registerMenuCommand) {
          GM.registerMenuCommand(label, fn);
        }
      } catch (e) {
        /* manager without menu support; the panel has buttons anyway */
      }
    },
  };

  /* ---------- 1. Config ---------- */
  const DEFAULTS = {
    enabled: true,
    model: "claude-haiku-4-5",
    effort: "medium",
    search: true,
    context: false,
    udm14: true,
    results: false,
    apiKey: "",
    // "" means "use the built-in SYSTEM below". Storing the empty string rather
    // than a copy of the default means later improvements to the default text
    // still reach anyone who never edited it.
    systemPrompt: "",
  };
  const MODELS = [
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-fable-5", "Fable 5"],
  ];
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const NO_EFFORT = new Set(["claude-haiku-4-5"]);

  const MODEL_RULES = {
    "claude-opus-5": {
      effort: true,
      thinking: "adaptive",
      search: "web_search_20260209",
      fetch: "web_fetch_20260209",
    },
    "claude-sonnet-5": {
      effort: true,
      thinking: "adaptive",
      search: "web_search_20260209",
      fetch: "web_fetch_20260209",
    },
    "claude-fable-5": {
      effort: true,
      thinking: "omit",
      search: "web_search_20250305",
      fetch: "web_fetch_20250910",
    },
    "claude-haiku-4-5": {
      effort: false,
      thinking: "omit",
      search: "web_search_20250305",
      fetch: "web_fetch_20250910",
    },
  };

  /* Local spend accounting. The Usage & Cost Admin API needs an Admin API key
     and is unavailable for individual accounts, so there is nothing to query -
     but every response already reports exactly what was billed, so the cost is
     computable here with no extra request and no second credential.

     USD per million tokens, from the pricing page (2026-08-22). Cache writes
     are 1.25x input at the 5-minute TTL, cache reads 0.1x. Prices change:
     these are an estimate for orientation, not an invoice. */
  const PRICES = {
    "claude-opus-5": { in: 5, out: 25, write: 6.25, read: 0.5 },
    "claude-sonnet-5": { in: 2, out: 10, write: 2.5, read: 0.2 },
    "claude-haiku-4-5": { in: 1, out: 5, write: 1.25, read: 0.1 },
    "claude-fable-5": { in: 10, out: 50, write: 12.5, read: 1 },
  };
  const SEARCH_PRICE = 0.01; // $10 per 1,000 searches

  function costOf(model, usage) {
    const p = PRICES[model];
    if (!p || !usage) return 0;
    const st = usage.server_tool_use || {};
    return (
      ((usage.input_tokens || 0) * p.in +
        (usage.output_tokens || 0) * p.out +
        (usage.cache_creation_input_tokens || 0) * p.write +
        (usage.cache_read_input_tokens || 0) * p.read) /
        1e6 +
      (st.web_search_requests || 0) * SEARCH_PRICE
    );
  }

  // Sub-cent answers are the norm, so a two-decimal figure would read as $0.00
  // for almost every query and tell the user nothing.
  const fmtCost = (c) =>
    "$" + (c >= 1 ? c.toFixed(2) : c >= 0.01 ? c.toFixed(3) : c.toFixed(4));

  const CACHE_TTL_MS = 5 * 60 * 1000;
  const HISTORY_CAP = 300; // GM value stores are smaller than extension storage
  const LEADER_TIMEOUT_MS = 30000;
  // Shown in manual mode. It has to say both that nothing is being spent and
  // that the overview is still gone, because those are the two things a reader
  // looking at an empty panel actually wonders about.
  const OFF_TEXT =
    "Manual \u2014 nothing is sent until you ask, and no credits are being spent. " +
    "Google's AI Overview stays suppressed.";

  /* The DEFAULT system prompt. Settings exposes this text in an editable box;
     whatever is stored under "systemPrompt" replaces this whole block, and an
     empty stored value falls back here. The search notes below are NOT part of
     the editable text — they are appended mechanically from the search toggle,
     so a custom prompt cannot end up claiming web access it does not have. */
  const SYSTEM = [
    "You are answering a web search query inline, in the slot where Google would",
    "otherwise show its AI Overview. The reader wants the answer, not an essay.",
    "",
    "Lead with the direct answer in the first sentence. Follow with at most two or",
    "three short sentences of the context that actually changes what the reader",
    "would do or think next. Keep sentences short. Stay under 90 words. Never",
    "state the same fact twice.",
    "",
    "Write plain prose. No headings, no bullet lists, no emoji, no preamble, no",
    "sign-off, no restating the question, and no closing follow-up question. You",
    "may use **bold** for a key term and `code` for literal syntax.",
    "Answer in the language the query is written in.",
    "",
    "When the answer points at one specific page the reader would go to next — a",
    "menu, a booking or tickets page, an official page, a spec, a download — link",
    "it inline as [short label](https://example.com/path). Only ever link a URL",
    "you actually saw in a search result; never guess or reconstruct one. At most",
    "two links, always inside the prose, never a list of sources at the end.",
    "",
    "If the query assumes something false, correct it directly in the first",
    "sentence rather than answering around it. Stay neutral and non-alarmist on",
    "health, politics, and safety, and say when something warrants a professional.",
    "Never imply you have personal experience or feelings.",
    "",
    "A <context> block giving the searcher's local time, time zone and region may",
    "precede the query. Use it only when the answer actually turns on where or",
    "when the question is asked — a nearby business, opening hours, what is on",
    "today, a regional price or availability. Ignore it otherwise. Never repeat it",
    "back, and never mention that you were given it.",
    "",
    "If the query is navigational (someone searching a brand or site name), say in",
    "one line what it appears to refer to and stop. If it is too ambiguous to",
    "answer, say what it most likely means and stop.",
  ].join("\n");

  const SEARCH_NOTE = [
    "",
    "You can search the web. Search when the answer depends on current or",
    "verifiable facts, and answer directly from knowledge when it does not — a",
    "definitional or conceptual query rarely needs a search. Keep searches few and",
    "targeted. Do not narrate your searching or list sources; just answer.",
  ].join("\n");

  /* Appended mechanically from the results toggle, exactly like SEARCH_NOTE, so
     a custom system prompt can never claim page content that was not actually
     attached.

     The URL warning is load-bearing. Google renders the destination as an
     abbreviated <cite> ("https://www.tembomoney.com > learn > spring-budget-..."),
     and on some page variants the anchor href is an opaque /goto?url= redirect
     rather than the destination - so a "URL" in this block is frequently not an
     address you can navigate to. The base prompt promises never to guess a link;
     without this, the results block would become the thing that breaks it. */
  const RESULTS_NOTE = [
    "",
    "A <results> block holding extracts of the search results Google rendered on",
    "this page may precede the query. Each entry is one result extract as it was",
    "shown, so it may also carry a source name, a date, a comment or view count,",
    "and sitelinks. They are extracts, not the pages themselves.",
    "",
    "Judge per query whether the block already answers it. Often it plainly does",
    "- a date, a price, a score, a name, a version number, opening hours, and the",
    "agreement of several results is itself evidence. Take it straight from the",
    "block in that case and answer immediately; do not fetch a page to confirm",
    "something already stated in front of you.",
    "",
    "Just as often it does not. A snippet is a fragment Google chose for matching",
    "the query's words, so it can share the query's vocabulary while never",
    "stating the fact asked for, break off mid-sentence, or answer a nearby",
    "question instead. When the specific thing asked for is not plainly there,",
    "treat the entries as leads rather than as the answer: fetch the URL of the",
    "most promising one and read the page, or search for it when no URL is given.",
    "Reading one good page beats stitching fragments into an answer none of them",
    "actually made.",
    "",
    "Results also disagree with each other, and with the pages behind them. Never",
    "repeat the list back, never summarise it result by result, and never mention",
    "that you were given it.",
    "An entry may begin with a line reading \"URL: \" and a full address; only",
    "those addresses may be fetched or linked. The address shown inside a",
    "result's own text is Google's abbreviated display form, often with an",
    "ellipsis, and is not a real address - never reconstruct, fetch or link one.",
  ].join("\n");

  /* Sent as a SECOND system block on follow-up turns only. It must never be
     merged into the block above: that one carries the cache_control breakpoint,
     and editing it would fork the ~6.2k-token prefix into a second entry keyed
     by whether the turn is a follow-up. Blocks placed after the breakpoint
     still match the cached prefix, so this costs a few tokens and nothing else.

     The base prompt is written for a one-shot overview — 90 words, no
     follow-up question, no preamble. Most of that is wrong once the reader is
     actually talking to you, so this relaxes exactly the parts that conflict. */
  const FOLLOWUP_NOTE = [
    "The reader has followed up on the answer above, so this is now a",
    "conversation rather than a search overview. Answer the follow-up directly,",
    "in plain prose, and assume everything already said is shared context — do",
    "not restate it. You may run to about 150 words when the question genuinely",
    "needs it, and you may end by naming a specific open question if one",
    "actually matters. Still no headings, no bullet lists, no preamble and no",
    "sign-off.",
  ].join("\n");

  const NO_SEARCH_NOTE = [
    "",
    "You have no web access for this answer, so answer from memory. If the query",
    "turns on facts that change over time — prices, standings, who currently holds",
    "a role, latest versions — say so plainly in a short clause instead of",
    "guessing at a current value.",
  ].join("\n");

  /* ---------- 2. udm=14 redirect ----------
     The extension used declarativeNetRequest; a userscript has to redirect the
     document itself. This is why @run-at document-start matters: it fires
     before Google renders, so the overview is never generated server-side.
     Guarded against loops in case Google ever strips the parameter. */
  const url = new URL(location.href);
  const query = url.searchParams.get("q") || "";

  // Only standard web results. Google's verticals — AI Mode (udm=50), Images
  // (2), Videos (7), News (12), Shopping (28) and the legacy tbm= ones — reuse
  // /search but lay out completely differently. AI Mode in particular keeps a
  // legacy #center_col in the DOM at display:none, so the panel mounted into
  // it, rendered nowhere, and still billed a full query on every page load.
  // Bail before styles, observers, or any request.
  const udm = url.searchParams.get("udm");
  const isWebResults = (udm === null || udm === "14") && !url.searchParams.has("tbm");
  if (!isWebResults) return;

  (function maybeRedirect() {
    if (!query || url.searchParams.has("udm")) return;
    let want;
    try {
      want = JSON.parse(localStorage.getItem("co:udm14"));
    } catch (e) {
      want = null;
    }
    if (want === false) return; // mirrored from settings below
    const guard = "co-udm-" + query;
    if (sessionStorage.getItem(guard)) return; // already tried this query
    sessionStorage.setItem(guard, "1");
    url.searchParams.set("udm", "14");
    location.replace(url.toString());
  })();

  /* ---------- 3. Suppress any AI Overview that still renders ---------- */
  const AIO_SELECTORS = [
    "#m-x-content",
    "[data-attrid='SGE']",
    "[data-attrid='AIOverview']",
    "div[data-mcpr]",
    "[jsname='ANWQ7b']",
  ];
  const AIO_LABELS = ["ai overview", "ai-powered overview", "resumen con ia"];

  GM_.style(AIO_SELECTORS.join(",") + "{display:none !important}");

  // Returns the AI Overview's own block, without removing it — the caller needs
  // its position. Google does not always put the overview first: on some
  // queries a direct result renders above it, so the block's location is the
  // only reliable way to land in the same slot.
  function findAIOverview(root) {
    const scope = root && root.querySelectorAll ? root : document;
    for (const sel of AIO_SELECTORS) {
      const hit = scope.querySelector ? scope.querySelector(sel) : null;
      if (hit && !hit.closest("#claude-overview") && hit.offsetHeight > 40) return hit;
    }
    const nodes = scope.querySelectorAll("h1,h2,h3,div[role='heading'],span");
    for (const n of nodes) {
      if (n.closest && n.closest("#claude-overview")) continue;
      const t = (n.textContent || "").trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (!AIO_LABELS.some((l) => t === l || t.startsWith(l))) continue;
      let node = n;
      for (let i = 0; i < 8 && node && node.parentElement; i++) {
        node = node.parentElement;
        if (node.id === "center_col" || node.id === "rcnt" || node === document.body) break;
        if (node.offsetHeight > 80) return node;
      }
    }
    return null;
  }

  // The detected block is the overview's content, but its chrome — the "Show
  // more" control and a clipped wrapper that reserves ~400px — lives further
  // up. Climb while the parent still holds no organic result, so the whole
  // unit goes and no empty gap is left behind.
  function overviewUnit(block) {
    // Hard structural guards first. Relying only on "does this ancestor hold a
    // result link" is not safe: if Google's result markup differs from the
    // probe, the climb walks straight past the results container and deletes
    // the page. Never absorb a node that contains the results roots.
    const guards = ["#search", "#rso", "#center_col", "#rcnt", "#botstuff"]
      .map((s) => document.querySelector(s))
      .filter(Boolean);

    let el = block;
    for (let i = 0; i < 10; i++) {
      const p = el.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (guards.some((g) => p === g || (p.contains(g) && !el.contains(g)))) break;
      // Secondary: don't absorb a sibling organic result.
      if ([...p.querySelectorAll("a h3")].some((h) => !el.contains(h))) break;
      el = p;
    }
    return el;
  }

  // Take over the overview's slot: move the panel to exactly where Google put
  // the overview, then delete it. Anything Google placed above it stays above.
  function sweepAIOverview(root) {
    const found = findAIOverview(root);
    if (!found) return false;
    const block = overviewUnit(found);
    if (!block || !block.parentElement) return false;
    const panel = document.getElementById("claude-overview");
    if (panel && panel !== block && !block.contains(panel)) {
      block.parentElement.insertBefore(panel, block);
    }
    block.remove();
    return true;
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) sweepAIOverview(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- 4. DOM helpers ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  /* Paced reveal. One mechanism covers both transports: text is pushed into a
     buffer that drains at a steady rate, so a manager that streams keeps the
     buffer near-empty and the reveal simply tracks it, while a manager that
     hands over the whole body at once (Tampermonkey on Firefox) gets typed out
     instead of appearing in a lump. The rate accelerates with backlog so a big
     burst never crawls, and reduced-motion users get the text immediately. */
  const REVEAL_BASE_CPS = 340;   // characters per second at rest
  const REVEAL_CATCHUP_S = 0.6;  // clear any backlog within roughly this long

  function makeReveal(render) {
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    let full = "";
    let shown = 0;
    let raf = null;
    let lastTs = 0;
    let ended = false;
    let onEnd = null;

    const paint = (streaming) => render(full.slice(0, shown), streaming);

    function step(ts) {
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.25, (ts - lastTs) / 1000);
      lastTs = ts;
      const pending = full.length - shown;
      const rate = Math.max(REVEAL_BASE_CPS, pending / REVEAL_CATCHUP_S);
      shown = Math.min(full.length, shown + Math.ceil(rate * dt));
      paint(shown < full.length || !ended);
      if (shown < full.length) {
        raf = requestAnimationFrame(step);
      } else {
        raf = null;
        if (ended && onEnd) {
          const fn = onEnd;
          onEnd = null;
          fn();
        }
      }
    }

    return {
      push(text) {
        full += text;
        if (reduced) {
          shown = full.length;
          paint(true);
          return;
        }
        if (!raf) {
          lastTs = 0;
          raf = requestAnimationFrame(step);
        }
      },
      // Resolves once everything buffered has actually been shown.
      finish(cb) {
        ended = true;
        if (reduced || shown >= full.length) {
          shown = full.length;
          paint(false);
          cb && cb();
        } else {
          onEnd = cb;
        }
      },
      // Cached answers are already instant; typing them out would be fake
      // latency. The cached path still arrives via push(), which will have
      // scheduled a frame — cancel it, or that frame repaints in streaming mode
      // and leaves the caret blinking after the answer is complete.
      instant(text) {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        ended = true;
        onEnd = null;
        full = text;
        shown = text.length;
        paint(false);
      },
      cancel() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        onEnd = null;
      },
    };
  }

  function modelLabel(id) {
    const hit = MODELS.find((m) => m[0] === id);
    return hit ? hit[1] : id;
  }
  function hostOf(u) {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch (e) {
      return u;
    }
  }

  /* Model picker. A native <select> pair could not show which efforts a model
     actually accepts — the effort control just went disabled after the fact,
     which reads as a bug. This is one control: models on the left, and the
     efforts *that model* accepts on the right, revealed on hover or focus.
     Picking a model keeps the current effort when that model accepts it;
     picking an effort picks its model too, so the pair is never inconsistent. */
  const EFFORT_NOTE = {
    low: "Fastest and cheapest",
    medium: "Balanced",
    high: "More reasoning",
    xhigh: "Deeper reasoning",
    max: "Most thorough, slowest",
  };
  const MODEL_NOTE = {
    "claude-haiku-4-5": "Fast, fixed effort",
    "claude-fable-5": "Creative",
    "claude-sonnet-5": "Balanced",
    "claude-opus-5": "Most capable",
  };
  const effortsFor = (id) => ((MODEL_RULES[id] || {}).effort ? EFFORTS : []);

  /* opts lets the compare rail reuse this menu wholesale rather than growing a
     second, subtly different picker:
       glyph        fixed trigger content instead of the live model/effort label
       cls          extra class on the wrapper, for positioning
       showCurrent  false when the menu is choosing a *new* column rather than
                    editing the current one, so nothing is ticked
       title        static tooltip, since the label no longer carries meaning */
  function buildModelMenu(cfg, onPick, opts) {
    opts = opts || {};
    const root = el("div", "co-menuwrap" + (opts.cls ? " " + opts.cls : ""));
    const btn = button("", "co-menubtn", () => (open ? closeMenu() : openMenu()));
    const label = el("span", "co-menulabel");
    if (opts.glyph) btn.append(el("span", "co-menuglyph", opts.glyph));
    else btn.append(label, el("span", "co-menucaret", "▾"));
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", "false");
    if (opts.title) btn.title = opts.title;

    const pop = el("div", "co-menu");
    pop.setAttribute("role", "menu");
    const modelCol = el("div", "co-menucol co-menumodels");
    const effortCol = el("div", "co-menucol co-menuefforts");
    pop.append(modelCol, effortCol);
    root.append(btn, pop);

    let open = false;
    let preview = cfg.model; // the row the pointer/keyboard is on, not the choice

    const row = (cls, text, note, onActivate) => {
      const b = button("", "co-menuitem " + cls, onActivate);
      b.setAttribute("role", "menuitem");
      const main = el("span", "co-menutext", text);
      b.append(el("span", "co-menucheck"), main);
      if (note) b.append(el("span", "co-menunote", note));
      return b;
    };

    // Left column is static; only the tick and the highlight move.
    const modelRows = MODELS.map(([id, name]) => {
      const r = row("co-menumodel", name, MODEL_NOTE[id] || "", () => {
        const allowed = effortsFor(id);
        // Keep the current effort if this model takes it, else its default.
        const effort = allowed.includes(cfg.effort) ? cfg.effort : "medium";
        closeMenu();
        onPick(id, effort);
      });
      r.dataset.model = id;
      const show = () => setPreview(id);
      r.addEventListener("mouseenter", show);
      r.addEventListener("focus", show);
      return r;
    });
    modelCol.append(...modelRows);

    function renderEfforts() {
      effortCol.textContent = "";
      const allowed = effortsFor(preview);
      effortCol.append(el("div", "co-menuhead", modelLabel(preview)));
      if (!allowed.length) {
        // Not an error state — say what happens instead of showing dead controls.
        effortCol.append(el("div", "co-menuempty", "Runs at a single fixed effort. Nothing to choose."));
        return;
      }
      for (const e of allowed) {
        const r = row("co-menueffort", e, EFFORT_NOTE[e], () => {
          closeMenu();
          onPick(preview, e);
        });
        // The tick only means "current" for the model that is actually selected.
        if (opts.showCurrent !== false && preview === cfg.model && e === cfg.effort) {
          r.classList.add("co-menuon");
        }
        effortCol.append(r);
      }
    }

    function setPreview(id) {
      preview = id;
      for (const r of modelRows) r.classList.toggle("co-menuhot", r.dataset.model === id);
      renderEfforts();
    }

    const onDocDown = (e) => {
      if (!root.contains(e.target)) closeMenu();
    };

    function openMenu() {
      open = true;
      root.classList.add("co-menuopen");
      btn.setAttribute("aria-expanded", "true");
      setPreview(opts.showCurrent === false ? MODELS[0][0] : cfg.model);
      document.addEventListener("mousedown", onDocDown, true);
      const cur =
        (opts.showCurrent === false ? null : modelRows.find((r) => r.dataset.model === cfg.model)) ||
        modelRows[0];
      cur && cur.focus();
    }
    function closeMenu(refocus) {
      if (!open) return;
      open = false;
      root.classList.remove("co-menuopen");
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onDocDown, true);
      if (refocus) btn.focus();
    }

    pop.addEventListener("keydown", (e) => {
      const inEfforts = effortCol.contains(e.target);
      const items = [...(inEfforts ? effortCol : modelCol).querySelectorAll(".co-menuitem")];
      const i = items.indexOf(e.target);
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        next && next.focus();
      } else if (e.key === "ArrowRight" && !inEfforts) {
        e.preventDefault();
        const first = effortCol.querySelector(".co-menuitem");
        first && first.focus();
      } else if (e.key === "ArrowLeft" && inEfforts) {
        e.preventDefault();
        const back = modelRows.find((r) => r.dataset.model === preview);
        back && back.focus();
      } else if (e.key === "Tab") {
        closeMenu();
      }
    });

    return {
      root,
      // Called after every config change, including ones made elsewhere.
      paint() {
        if (opts.showCurrent === false) {
          if (open) renderEfforts();
          return;
        }
        const allowed = effortsFor(cfg.model);
        if (!opts.glyph) {
          label.textContent =
            modelLabel(cfg.model) + (allowed.length ? " · " + cfg.effort : "");
          btn.title = allowed.length
            ? modelLabel(cfg.model) + " at " + cfg.effort + " effort"
            : modelLabel(cfg.model) + " — fixed effort";
        }
        for (const r of modelRows) {
          const on = r.dataset.model === cfg.model;
          r.classList.toggle("co-menuon", on);
          r.setAttribute("aria-checked", String(on));
        }
        if (open) renderEfforts();
      },
      close: closeMenu,
    };
  }

  // Still never innerHTML: links are built as elements and href is assigned as
  // a property, so nothing model-authored is ever parsed as markup. The scheme
  // is checked against an allowlist because a bare href would happily accept
  // javascript: — an anchor is the one construct here that can execute.
  function renderLink(target, tok) {
    const cut = tok.indexOf("](");
    const label = tok.slice(1, cut);
    const href = tok.slice(cut + 2, -1);
    let ok = false;
    try {
      const u = new URL(href);
      ok = u.protocol === "http:" || u.protocol === "https:";
    } catch (e) {
      /* not a URL at all */
    }
    if (!ok) return void target.append(tok); // show the raw text, link nothing
    const a = el("a", "co-link", label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    target.append(a);
  }

  // Text nodes only — model output is never treated as markup.
  function renderMarkdown(target, text) {
    target.textContent = "";
    const re = /(\[[^\]]{1,80}\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
    for (const line of text.split("\n")) {
      let last = 0;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        if (m.index > last) target.append(line.slice(last, m.index));
        const tok = m[0];
        if (tok.startsWith("[")) {
          renderLink(target, tok);
        } else {
          const isCode = tok.startsWith("`");
          const node = el(isCode ? "code" : "strong");
          node.textContent = isCode ? tok.slice(1, -1) : tok.slice(2, -2);
          target.append(node);
        }
        last = m.index + tok.length;
      }
      if (last < line.length) target.append(line.slice(last));
      target.append("\n");
    }
  }

  function faviconFor(u) {
    const host = hostOf(u);
    const img = el("img", "co-fav");
    img.width = 16;
    img.height = 16;
    img.loading = "lazy";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src =
      "https://wsrv.nl/?url=" +
      encodeURIComponent("icons.duckduckgo.com/ip3/" + host + ".ico") +
      "&w=32&h=32&fit=cover&maxage=7d&default=" +
      encodeURIComponent(host + "/favicon.ico");
    img.addEventListener("error", () => {
      img.replaceWith(el("span", "co-fav co-favtxt", host.charAt(0).toUpperCase()));
    });
    return img;
  }

  function renderSources(container, sources, queries) {
    container.textContent = "";
    if (!sources || !sources.length) return;
    const pill = button("", "co-pill", () => {
      const open = list.style.display !== "none";
      list.style.display = open ? "none" : "";
      pill.setAttribute("aria-expanded", String(!open));
    });
    const stack = el("span", "co-favs");
    for (const s of sources.slice(0, 5)) stack.append(faviconFor(s.url));
    // "results", not "sources": the API emits no citations for web_search, so
    // there is no way to know which pages actually informed the answer.
    pill.append(stack, el("span", null, sources.length + (sources.length === 1 ? " result" : " results")));
    pill.setAttribute("aria-expanded", "false");

    const list = el("div", "co-srclist");
    list.style.display = "none";
    list.append(
      el(
        "div",
        "co-srcq",
        queries && queries.length
          ? "Searched: " + queries.join(" · ")
          : "Pages returned by Claude's searches — not all were necessarily used"
      )
    );
    for (const s of sources) {
      const a = el("a", "co-src");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.append(faviconFor(s.url), el("span", "co-srct", s.title), el("span", "co-srch", hostOf(s.url)));
      list.append(a);
    }
    container.append(pill, list);
  }

  /* ---------- 4b. Page context ----------
     Everything here varies per request, so it goes in the USER MESSAGE, after
     the cache_control breakpoint — never in the system block. Putting it in
     the system block would invalidate the ~6.2k-token cached prefix on every
     single query and undo the caching entirely.

     Off by default, and deliberately so: with it on, every search sends
     Anthropic a rough location alongside the query. The settings note spells
     out exactly what leaves the page. */
  /* Structural, not class-based. Google's SERP class names are obfuscated and
     rotate (the measured ones were .Q8LRLc / .AhYzQb), so none of them appear
     here. Two properties that are not cosmetic do the work instead:

       - The location control is the only anchor in the footer that is a
         role="button" pointing at href="#": it opens a picker rather than
         navigating anywhere. Its first text leaf is the locality.
       - The country is the first visible leaf in the footer that is not inside
         a link at all - every other footer string (Help, Privacy, Terms,
         "Update location") is a link, and the hidden status strings have no
         layout box.

     Both survive a class rename and neither depends on the interface language.
     Verified against a live SERP on 2026-08-22, which yielded a locality and a
     country from an unmodified footer. */
  function googlePlace() {
    try {
      const foot = document.querySelector("#footcnt");
      if (!foot) return "";

      const firstLeaf = (node) => {
        if (!node) return "";
        const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
          const t = (n.textContent || "").trim();
          if (t) return t.length < 60 ? t : "";
        }
        return "";
      };

      const ctrl =
        foot.querySelector('a[role="button"][href="#"]') || foot.querySelector('a[href="#"]');
      const city = firstLeaf(ctrl);

      let country = "";
      for (const n of foot.querySelectorAll("span,div")) {
        if (n.children.length || n.closest("a")) continue;
        const t = (n.textContent || "").trim();
        if (t.length < 2 || t.length > 40) continue;
        if (!/\p{L}/u.test(t)) continue; // separators like "-"
        if (!n.offsetParent) continue; // hidden status strings
        country = t;
        break;
      }

      return [city, country].filter(Boolean).join(", ");
    } catch (e) {
      return ""; // never let a layout change break the request
    }
  }

  /* Precise coordinates, but only ones the user already handed to Google.
     navigator.permissions.query never prompts, so this can look before it
     leaps: on "granted" the fix is already the user's decision, and on
     "prompt" we do nothing at all. A search page that suddenly raises a
     location dialog is indistinguishable from a hijack, so it must never
     happen because of this script.

     Primed once at boot rather than awaited per request: a cold fix can take
     seconds, and no answer should wait on the GPS. maximumAge lets a fix
     Google already obtained come back instantly. */
  let geoFix = null;
  function primeGeo() {
    if (!navigator.geolocation || !navigator.permissions) return;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((p) => {
        if (p.state !== "granted") return;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            geoFix = {
              lat: pos.coords.latitude,
              lon: pos.coords.longitude,
              acc: pos.coords.accuracy,
            };
          },
          () => {
            /* user revoked, or no fix available */
          },
          { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 }
        );
      })
      .catch(() => {
        /* permissions API without geolocation support */
      });
  }

  // Returns the block to prepend, plus a coarse signature for the answer cache
  // key. The signature deliberately omits the clock — otherwise every minute
  // would be a fresh key and the local answer cache would never hit.
  function pageContext() {
    const now = new Date();
    let tz = "";
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch (e) {
      /* older engine */
    }
    const gl = (url.searchParams.get("gl") || "").toUpperCase();
    const hl = url.searchParams.get("hl") || document.documentElement.lang || "";
    const place = googlePlace();

    const lines = ["Local time: " + now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })];
    if (tz) lines.push("Time zone: " + tz);
    if (place) lines.push("Location Google reports for this search: " + place);
    // ~110 m of precision. Full float precision would pin the user to a room
    // for no gain: nothing downstream is more precise than a street.
    if (geoFix) {
      lines.push(
        "Coordinates: " +
          geoFix.lat.toFixed(3) +
          ", " +
          geoFix.lon.toFixed(3) +
          " (accurate to about " +
          Math.round(geoFix.acc) +
          " m)"
      );
    }
    if (gl) lines.push("Google country: " + gl);
    if (hl) lines.push("Interface language: " + hl);

    return {
      text: "<context>\n" + lines.join("\n") + "\n</context>",
      // Coordinates enter the cache signature rounded harder than they are
      // sent (~1 km), so walking down the street does not miss the cache.
      sig: [
        now.toISOString().slice(0, 10),
        tz,
        place,
        gl,
        geoFix ? geoFix.lat.toFixed(2) + "," + geoFix.lon.toFixed(2) : "",
      ].join("~"),
    };
  }

  /* ---------- 4c. The page's own search results ----------
     Sent only when the user turns it on. Like pageContext this rides in the
     USER MESSAGE, after the cache_control breakpoint, so it never invalidates
     the ~6.2k-token cached prefix.

     Structural, not class-based - Google's SERP class names are obfuscated and
     rotate (measured here: .zReHs / .yuRUbf / .kb0PBd). Three properties that
     are not cosmetic do the work instead, all verified against a live SERP on
     2026-09-06, both with and without udm=14:

       - An organic result is an anchor inside #rso containing an <h3>. That is
         the same signal overviewUnit() already trusts to avoid eating the
         results column, so if it breaks, more than this function is broken.
       - [data-hveid] is the result's own container: the nearest such ancestor
         of the anchor held exactly one <h3> and the whole rendered result -
         title, source, date or comment count, snippet, sitelinks - and no more.
       - <cite> holds the displayed URL, or on social and video results the meta
         line instead ("4 comments - 5 years ago").

     The whole rendered text of each block is sent rather than parsed fields.
     Google puts dates in at least two different places (an "Aug 27, 2026 - "
     prefix on the snippet, or inside the cite meta line), and a parse that
     tries to normalise that loses more than it gains. */

  // Google does not always expose the destination: on some page variants every
  // result href is an opaque /goto?url=CAESaQ... redirect, so no real URL is
  // available and the <cite> text - abbreviated with an ellipsis - is all there
  // is. Returning null rather than the redirect matters, because the system
  // prompt permits linking any URL the model was given.
  function resultUrl(a) {
    const raw = a.getAttribute("href") || "";
    if (!raw || raw.startsWith("#")) return null;
    let u;
    try {
      u = new URL(a.href);
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    // Any google host here is a redirector (/goto, /url), not a destination.
    if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return null;
    return u.href;
  }

  // Bounds the worst case (expanded sitelinks on every result) so the feature
  // cannot quietly multiply what a query costs. Ordinary queries measure 2-4k.
  const RESULTS_CHAR_CAP = 12000;

  function pageResults() {
    try {
      const root = document.querySelector("#rso") || document.querySelector("#search");
      if (!root) return null;

      const seen = new Set();
      const entries = [];
      for (const a of root.querySelectorAll("a")) {
        if (!a.querySelector("h3")) continue;
        if (a.closest("#claude-overview")) continue; // never feed the panel back
        const block = a.closest("[data-hveid]") || a.parentElement;
        if (!block || seen.has(block)) continue;
        seen.add(block);

        // innerText, not textContent: it reflects what was actually rendered,
        // skipping hidden nodes and keeping Google's own line breaks.
        let text = (block.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
        // The first result on a page also absorbs the section heading
        // Google renders above the list ("Web results"), because that
        // heading lives inside the same [data-hveid]. A rendered result
        // always begins with its own title, so anything before the title
        // is chrome rather than content.
        const title = (block.querySelector("h3").innerText || "").trim();
        const at = title ? text.indexOf(title) : -1;
        if (at > 0 && at < 80) text = text.slice(at);
        if (!text) continue;
        const url = resultUrl(a);
        // The URL line is added ONLY when a real destination was
        // recoverable. Google renders the address inside the result text
        // anyway (abbreviated, as a <cite>), so a line announcing its
        // absence would repeat on every entry and say nothing - measured
        // at ~700 wasted characters on an ordinary 8-result page. Which
        // entries are linkable is exactly what its presence encodes.
        entries.push(url ? "URL: " + url + "\n" + text : text);
      }
      if (!entries.length) return null;

      let text = "";
      let n = 0;
      for (const e of entries) {
        const next = (n ? "\n\n" : "") + "[" + (n + 1) + "]\n" + e;
        if (text.length + next.length > RESULTS_CHAR_CAP) break;
        text += next;
        n++;
      }
      if (!n) return null;

      return {
        text: "<results>\n" + text + "\n</results>",
        count: n,
        chars: text.length,
        // Keys the answer cache: a different result set must not replay an
        // answer that was built from the previous one.
        sig: hashStr(text),
      };
    } catch (e) {
      return null; // never let a SERP layout change break the request
    }
  }

  /* Results are rendered by Google's own scripts, so at document-start they are
     usually not in the DOM yet. Every path except the cold auto-run - the
     manual "Ask Claude" button, Regenerate, a follow-up - happens long after
     load and returns on the first line without waiting at all.

     The deadline is what makes this safe: a SERP that never populates #rso (a
     layout change, a consent interstitial) has to degrade to sending no
     results, not hang the panel with a caret blinking forever. */
  const RESULTS_WAIT_MS = 1500;

  function awaitResults() {
    const ready = pageResults();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        mo.disconnect();
        resolve(pageResults());
      };
      const mo = new MutationObserver(() => {
        if (pageResults()) finish();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(finish, RESULTS_WAIT_MS);
    });
  }

  /* ---------- 5. Cross-tab prompt-cache gate ----------
     Without a shared background worker, tabs coordinate through the GM value
     store. A cache entry is only readable once the first response begins
     streaming, so concurrent cold requests would each pay a ~6.2k-token write.
     One tab takes the lock and the rest wait for its first byte. */
  /* The prompt text is part of the key: the cached prefix IS the system block
     plus the tool definitions, so editing the prompt makes every existing entry
     unreachable. Without this the warm chip would count down against a prefix
     nothing is going to read, and the leader gate would hold tabs for a write
     that already happened under the old text. Entries left behind by a previous
     prompt are never read again and expire on their own five minutes later. */
  /* results is part of the key for the same reason search is: RESULTS_NOTE is
     appended to the system block, so the two variants are different cached
     prefixes. Without it the warm chip would count down against a prefix
     nothing is going to read, and the leader gate would hold other tabs for a
     write that already happened under the other variant. */
  const prefixKey = (model, search, ph, results) =>
    "cw:" + model + ":" + (search ? "s" : "n") + (ph ? ":" + ph : "") + (results ? ":r" : "");
  const lockKey = (pk) => "lock:" + pk;

  async function isWarm(pk) {
    const v = await GM_.get(pk, null);
    return !!(v && v.expires > Date.now());
  }

  async function acquirePrefix(pk) {
    if (await isWarm(pk)) return null;

    const held = await GM_.get(lockKey(pk), 0);
    if (held && Date.now() - held < LEADER_TIMEOUT_MS) {
      const deadline = Date.now() + LEADER_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await isWarm(pk)) return null;
        const still = await GM_.get(lockKey(pk), 0);
        if (!still || Date.now() - still > LEADER_TIMEOUT_MS) return null;
      }
      return null;
    }

    const stamp = Date.now();
    await GM_.set(lockKey(pk), stamp);
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        const cur = await GM_.get(lockKey(pk), 0);
        if (cur === stamp) await GM_.set(lockKey(pk), 0);
      },
    };
  }

  /* ---------- 6. History ---------- */
  async function recordHistory(entry) {
    const history = (await GM_.get("history", [])) || [];
    history.unshift(entry);
    if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
    await GM_.set("history", history);
  }

  /* ---------- 7. The API call ----------
     GM_xmlhttpRequest rather than fetch: it is not subject to Google's CSP and
     is the only cross-origin path available to a userscript. Managers deliver
     the body incrementally through onprogress, so SSE is parsed from a moving
     offset into responseText. */
  /* Answers persist in the manager's store, not just in memory, so a reload —
     or a back/forward, or reopening the same search tomorrow — re-renders the
     previous answer instead of paying for it again. Keyed by the full request
     shape, so changing model, effort or search re-runs, and changing back
     reuses. Search-backed answers expire quickly because they assert current
     facts; knowledge answers do not age nearly as fast. */
  const ANSWER_CAP = 120;
  const TTL_SEARCH_MS = 60 * 60 * 1000;
  const TTL_PLAIN_MS = 24 * 60 * 60 * 1000;

  async function readAnswer(ck, search) {
    const all = (await GM_.get("answers", {})) || {};
    const hit = all[ck];
    if (!hit) return null;
    const ttl = search ? TTL_SEARCH_MS : TTL_PLAIN_MS;
    if (!hit.ts || Date.now() - hit.ts > ttl) return null;
    return hit;
  }

  async function writeAnswer(ck, entry) {
    const all = (await GM_.get("answers", {})) || {};
    all[ck] = entry;
    const keys = Object.keys(all);
    if (keys.length > ANSWER_CAP) {
      keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
      for (const k of keys.slice(0, keys.length - ANSWER_CAP)) delete all[k];
    }
    await GM_.set("answers", all);
  }

  /* Threads are persisted for the same reason answers are: a reload should
     replay the conversation instead of re-billing it. Keyed by the first
     turn's request shape, so changing model, effort, search or context starts
     a fresh conversation rather than grafting new turns onto an old one. */
  const THREAD_CAP = 40;

  async function readThread(tk, search) {
    const all = (await GM_.get("threads", {})) || {};
    const hit = all[tk];
    if (!hit) return null;
    const ttl = search ? TTL_SEARCH_MS : TTL_PLAIN_MS;
    if (!hit.ts || Date.now() - hit.ts > ttl) return null;
    return hit;
  }

  async function writeThread(tk, turns) {
    const all = (await GM_.get("threads", {})) || {};
    all[tk] = { turns, ts: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > THREAD_CAP) {
      keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
      for (const k of keys.slice(0, keys.length - THREAD_CAP)) delete all[k];
    }
    await GM_.set("threads", all);
  }

  async function dropThread(tk) {
    const all = (await GM_.get("threads", {})) || {};
    if (!all[tk]) return;
    delete all[tk];
    await GM_.set("threads", all);
  }

  // Cheap, stable key material for a message list — not a security hash.
  const hashStr = (str) => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };

  function ask(cfg, handlers, force, convo) {
    const { model, effort, search } = cfg;
    const state = { aborted: false, handle: null };
    const started = Date.now();
    // prior holds the turns already exchanged, exactly as they were sent, so a
    // follow-up replays byte-identical text and the cached prefix still hits.
    const conv = convo || { prior: [], question: null };
    const isFollowUp = conv.prior.length > 0;

    (async () => {
      // Read the flag at request time rather than from cfg, so toggling it in
      // settings takes effect without rebuilding the columns. The context
      // signature is part of the answer-cache key: a location- or date-
      // dependent answer must not be replayed for a different day or place.
      const wantContext = await GM_.get("context", DEFAULTS.context);
      const ctx = wantContext ? pageContext() : null;
      // Same reasoning, and gathered here rather than in run() so every caller
      // - first turn, regenerate, settings re-run - goes through one path. On a
      // follow-up it is skipped: the results rode the first turn and are
      // already in the thread.
      const wantResults = await GM_.get("results", DEFAULTS.results);
      const res = wantResults && !isFollowUp ? await awaitResults() : null;
      // awaitResults can wait up to 1.5s, which is long enough for the column
      // to have been torn down under us.
      if (state.aborted) return;
      // Same reasoning: read at request time, so an edit in settings applies to
      // the next question without rebuilding the columns. A blank or
      // whitespace-only stored value means "use the default".
      const stored = (await GM_.get("systemPrompt", DEFAULTS.systemPrompt)) || "";
      const basePrompt = stored.trim() || SYSTEM;
      const ph = hashStr(basePrompt);
      // The context rides on the first user turn only; later turns inherit it
      // through the thread rather than repeating it every message.
      const sentUser = isFollowUp
        ? conv.question
        : [ctx && ctx.text, res && res.text, query].filter(Boolean).join("\n\n");
      // ph is in the answer-cache key too, or editing the prompt would replay
      // an answer the old prompt produced and the edit would look like a no-op.
      const ck = isFollowUp
        ? [model, effort, search ? "s" : "n", ph, "f", hashStr(JSON.stringify(conv.prior) + sentUser)].join("|")
        : [model, effort, search ? "s" : "n", ph, ctx ? ctx.sig : "-", res ? res.sig : "-", query].join("|");

      // Regenerate sets force, so it always reaches the API — otherwise the
      // button would just re-render the cached answer and appear to do nothing.
      if (!force) {
        const hit = await readAnswer(ck, search);
        if (hit && !state.aborted) {
          handlers.delta(hit.text);
          handlers.done({
            model,
            usage: hit.usage,
            cached: true,
            ts: hit.ts,
            sources: hit.sources,
            queries: hit.queries,
            sentUser,
            ph,
          });
          return;
        }
      }

      const apiKey = await GM_.get("apiKey", "");
      if (!apiKey) {
        return handlers.error("No Anthropic API key set. Open settings to add one.", true);
      }

      const pk = prefixKey(model, search, ph, !!res);
      let gate = null;
      if (search) {
        const held = await GM_.get(lockKey(pk), 0);
        if (held && Date.now() - held < LEADER_TIMEOUT_MS && !(await isWarm(pk))) {
          handlers.queued();
        }
        gate = await acquirePrefix(pk);
      }
      if (state.aborted) {
        if (gate) gate.release();
        return;
      }

      const rules = MODEL_RULES[model] || MODEL_RULES["claude-opus-5"];
      const body = {
        model,
        max_tokens: search ? 4096 : 1024,
        stream: true,
        // tools -> system -> messages, so this breakpoint also caches the
        // ~5.8k-token web_search tool definition.
        system: [
          {
            type: "text",
            text:
              basePrompt +
              (search ? SEARCH_NOTE : NO_SEARCH_NOTE) +
              (res ? RESULTS_NOTE : ""),
            cache_control: { type: "ephemeral" },
          },
        ],
        // After the breakpoint by construction: messages render last, so the
        // per-request context costs nothing in cache terms.
        messages: conv.prior
          .map((t) => ({ role: t.role, content: t.text }))
          .concat([
            {
              role: "user",
              content: isFollowUp
                ? // Second breakpoint: caches everything up to and including
                  // this turn, so the NEXT follow-up reads the whole
                  // conversation instead of re-paying for it. Two breakpoints
                  // total, well inside the limit of four.
                  [{ type: "text", text: sentUser, cache_control: { type: "ephemeral" } }]
                : sentUser,
            },
          ]),
      };
      // Relaxes the one-shot rules the base prompt imposes. Appended after the
      // cached block, so the prefix still matches and nothing is re-written.
      if (isFollowUp) body.system.push({ type: "text", text: FOLLOWUP_NOTE });
      body.tools = [];
      if (search) body.tools.push({ type: rules.search, name: "web_search", max_uses: 4 });
      /* web_fetch can only retrieve URLs already present in the conversation,
         so it is useless without the results block and exactly right with it:
         the results are leads, and this is what turns a lead into the page
         itself. Bounded deliberately - each fetched page is fresh input on
         top of the prefix, so max_uses and max_content_tokens are the two
         numbers that keep an answer from costing several cents. */
      if (res && rules.fetch) {
        body.tools.push({
          type: rules.fetch,
          name: "web_fetch",
          max_uses: 3,
          max_content_tokens: 6000,
        });
      }
      if (!body.tools.length) delete body.tools;
      if (rules.effort) body.output_config = { effort };
      if (rules.thinking === "adaptive") body.thinking = { type: "adaptive" };

      let idx = 0;
      let buf = "";
      let acc = "";
      let usage = {};
      let stopReason = null;
      let searchCount = 0;
      let fetchCount = 0;
      const queries = [];
      const sources = [];
      const seen = new Set();
      let toolBlock = null;
      let toolJson = "";

      const releaseGate = () => {
        if (gate) {
          gate.release();
          gate = null;
        }
      };
      const addSource = (u, title) => {
        if (!u || seen.has(u)) return;
        seen.add(u);
        sources.push({ url: u, title: title || u });
      };

      function consume(text) {
        buf += text;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let ev;
            try {
              ev = JSON.parse(payload);
            } catch (e) {
              continue;
            }
            releaseGate(); // entry is readable once the response has started

            if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
              acc += ev.delta.text;
              handlers.delta(ev.delta.text);
            } else if (ev.type === "content_block_start" && ev.content_block) {
              const cb = ev.content_block;
              // The dynamic-filtering variant runs its searches from inside
              // code_execution, so count result batches, not tool uses.
              if (cb.type === "server_tool_use" && cb.name === "web_search") {
                toolBlock = ev.index;
                toolJson = "";
              } else if (cb.type === "web_search_tool_result") {
                searchCount++;
                for (const r of Array.isArray(cb.content) ? cb.content : []) {
                  addSource(r.url, r.title);
                }
                handlers.searching(searchCount);
                if (sources.length) handlers.sources(sources);
              } else if (cb.type === "web_fetch_tool_result") {
                /* A fetch is stronger evidence than a search hit: the page was
                   actually retrieved and read, so it belongs in the source list
                   even though web_search results carry no citations. Errors
                   arrive here too, as a single object rather than a list - the
                   API returns HTTP 200 with an error_code and never throws. */
                const c = cb.content;
                if (c && !c.error_code) {
                  fetchCount++;
                  addSource(c.url, (c.document && c.document.title) || c.url);
                  handlers.fetching(fetchCount);
                  if (sources.length) handlers.sources(sources);
                }
              }
            } else if (
              ev.type === "content_block_delta" &&
              ev.delta &&
              ev.delta.type === "input_json_delta" &&
              ev.index === toolBlock
            ) {
              toolJson += ev.delta.partial_json || "";
            } else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "citations_delta") {
              const c = ev.delta.citation;
              if (c) addSource(c.url, c.title);
            } else if (ev.type === "content_block_stop" && ev.index === toolBlock) {
              try {
                const q = JSON.parse(toolJson).query;
                if (q) queries.push(q);
              } catch (e) {
                /* partial input */
              }
              toolBlock = null;
            } else if (ev.type === "message_start" && ev.message) {
              usage = Object.assign(usage, ev.message.usage);
            } else if (ev.type === "message_delta") {
              usage = Object.assign(usage, ev.usage);
              if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            } else if (ev.type === "error") {
              handlers.error((ev.error && ev.error.message) || "Stream error");
            }
          }
        }
      }

      async function finish() {
        releaseGate();
        if (state.aborted) return;

        if (stopReason === "refusal") {
          handlers.error("Claude declined to answer this query.");
          await recordHistory({
            ts: started,
            query: isFollowUp ? conv.question : query,
            followUp: isFollowUp || undefined,
            model,
            effort,
            search,
            error: "refusal",
          });
          return;
        }
        if (!acc.trim()) {
          handlers.error("Empty response from the API.");
          return;
        }

        if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
          await GM_.set(pk, {
            model,
            search: !!search,
            expires: Date.now() + CACHE_TTL_MS,
            tokens: usage.cache_read_input_tokens || usage.cache_creation_input_tokens || 0,
          });
        }
        await writeAnswer(ck, { text: acc, usage, sources, queries, ts: Date.now() });
        await recordHistory({
          ts: started,
          ms: Date.now() - started,
          // The follow-up text is the searchable query for this entry; the
          // thread id keeps the turns of one conversation findable together.
          query: isFollowUp ? conv.question : query,
          followUp: isFollowUp || undefined,
          thread: conv.threadId || undefined,
          turn: isFollowUp ? conv.prior.length / 2 + 1 : 1,
          model,
          effort,
          search,
          searches: searchCount,
          fetches: fetchCount,
          queries,
          sources,
          answer: acc,
          usage,
          cost: costOf(model, usage),
        });
        handlers.done({ model, usage, sources, queries, sentUser, ph, cost: costOf(model, usage) });
      }

      // Two transports, because they differ by manager. Tampermonkey on Firefox
      // does not grow responseText during onprogress — it buffers the whole
      // body and hands it over at onload, so the answer appears in one lump.
      // Its documented streaming path is responseType:"stream", which exposes a
      // ReadableStream on onloadstart. Chrome-side managers and Violentmonkey
      // stream fine through onprogress, so that stays as the fallback.
      let viaStream = false;
      let settled = false;

      const fail = (message, needsKey) => {
        if (settled) return;
        settled = true;
        releaseGate();
        handlers.error(message, needsKey);
      };
      const complete = () => {
        if (settled) return;
        settled = true;
        finish();
      };
      const httpError = (status, text) => {
        let detail = "";
        try {
          detail = (JSON.parse(text).error || {}).message || "";
        } catch (e) {
          /* non-JSON body */
        }
        fail("API error " + status + (detail ? ": " + detail : ""), status === 401);
      };

      state.handle = GM_.xhr({
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        data: JSON.stringify(body),
        responseType: "stream",
        onloadstart(res) {
          const rs = res && res.response;
          if (!rs || typeof rs.getReader !== "function") return; // manager ignored it
          viaStream = true;
          const status = res.status || 200;
          const reader = rs.getReader();
          const dec = new TextDecoder();
          let errBuf = "";
          (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk =
                  typeof value === "string" ? value : dec.decode(value, { stream: true });
                if (status < 200 || status >= 300) errBuf += chunk;
                else consume(chunk);
              }
            } catch (e) {
              if (!state.aborted) return fail("Stream failed: " + e.message);
              return;
            }
            if (status < 200 || status >= 300) return httpError(status, errBuf);
            complete();
          })();
        },
        onprogress(res) {
          if (viaStream) return;
          const t = res.responseText || "";
          if (t.length > idx) {
            consume(t.slice(idx));
            idx = t.length;
          }
        },
        onload(res) {
          if (viaStream) return; // the reader owns completion
          const t = res.responseText || "";
          if (res.status < 200 || res.status >= 300) return httpError(res.status, t);
          if (t.length > idx) {
            consume(t.slice(idx));
            idx = t.length;
          }
          complete();
        },
        onerror(e) {
          fail("Network error: " + ((e && e.error) || "request failed"));
        },
        onabort() {
          settled = true;
          releaseGate();
        },
      });
    })();

    return {
      abort() {
        state.aborted = true;
        try {
          if (state.handle && state.handle.abort) state.handle.abort();
        } catch (e) {
          /* manager without abort support */
        }
      },
    };
  }

  /* ---------- 8. Column ---------- */
  const columns = [];
  let ui = null;

  class Column {
    constructor(cfg, host, onRemove) {
      this.cfg = Object.assign({}, cfg);
      this.onRemove = onRemove;
      this.req = null;

      this.root = el("div", "co-col");
      const head = el("div", "co-colhead");
      this.head = head;

      // One control for model + effort: see buildModelMenu. Both arrive
      // together, so there is never a moment where the effort belongs to the
      // previously selected model.
      this.menu = buildModelMenu(this.cfg, (model, effort) => {
        const same = model === this.cfg.model && effort === this.cfg.effort;
        this.cfg.model = model;
        this.cfg.effort = effort;
        this.menu.paint();
        this.persistIfPrimary();
        if (!same) this.run();
      });
      this.searchBtn = button("Search", "co-chip", () => {
        this.cfg.search = !this.cfg.search;
        this.paintSearch();
        this.persistIfPrimary();
        this.run();
      });
      this.close = button("×", "co-close", () => this.destroy());
      head.append(this.menu.root, this.searchBtn, this.close);

      this.body = el("div", "co-body");
      this.srcs = el("div", "co-srcs");
      this.foot = el("div", "co-foot");
      // Per-column conversation. Each column keeps its own thread: a follow-up
      // asked here is answered here, so two columns can diverge deliberately.
      this.thread = [];
      this.storedTurns = [];
      this.threadKey = "";
      this.convoReq = null;
      this.convoReveal = null;
      this.convo = this.buildConvo();
      // Sources sit ABOVE the answer: they say what the answer was built from,
      // which is context you want before reading it, not a footnote after.
      this.root.append(head, this.srcs, this.body, this.foot, this.convo.root);
      host.append(this.root);

      this.paintSearch();
      this.menu.paint();
    }

    get isPrimary() {
      return this.root.previousElementSibling === null;
    }
    persistIfPrimary() {
      if (!this.isPrimary) return;
      GM_.set("model", this.cfg.model);
      GM_.set("effort", this.cfg.effort);
      GM_.set("search", this.cfg.search);
    }
    paintSearch() {
      this.searchBtn.setAttribute("aria-pressed", String(!!this.cfg.search));
      this.searchBtn.title = this.cfg.search ? "Web search on" : "Web search off";
    }
    setCloseVisible(v) {
      this.close.style.display = v ? "" : "none";
    }
    stop() {
      if (this.req) this.req.abort();
      this.req = null;
      if (this.convoReq) this.convoReq.abort();
      this.convoReq = null;
      if (this.reveal) this.reveal.cancel();
      this.reveal = null;
      if (this.convoReveal) this.convoReveal.cancel();
      this.convoReveal = null;
      this.body.classList.remove("co-fade");
      this.foot.classList.remove("co-fade");
    }
    destroy() {
      this.stop();
      this.menu.close();
      this.root.remove();
      this.onRemove(this);
    }
    idle(msg) {
      this.stop();
      this.resetConvo();
      this.body.textContent = "";
      this.srcs.textContent = "";
      this.body.append(el("div", "co-muted", msg));
      this.foot.textContent = "";
      this.foot.append(button("Ask Claude", "co-run", () => this.run()));
    }

    /* The follow-up affordance stays collapsed to a single text button until
       used: an always-open input under every answer would read as a chat box
       bolted onto a search result, which this is not. */
    buildConvo() {
      const root = el("div", "co-convo");
      const turns = el("div", "co-turns");

      const form = el("form", "co-askform");
      form.style.display = "none";
      const input = el("input", "co-askinput");
      input.type = "text";
      input.placeholder = "Ask a follow-up";
      input.autocomplete = "off";
      input.spellcheck = false;
      const send = el("button", "co-run");
      send.type = "submit";
      send.textContent = "Ask";
      form.append(input, send);

      const opener = button("Ask a follow-up", "co-run co-opener", () => {
        opener.style.display = "none";
        form.style.display = "";
        input.focus();
      });
      opener.style.display = "none"; // shown once an answer has landed

      const collapse = () => {
        form.style.display = "none";
        opener.style.display = "";
      };
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        collapse();
        this.askFollowUp(text);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          collapse();
        }
      });

      root.append(turns, opener, form);
      return { root, turns, opener, form, input };
    }

    // Called once the first answer is on screen; until then there is nothing
    // to follow up on.
    enableConvo(on) {
      this.convo.opener.style.display = on ? "" : "none";
      if (!on) this.convo.form.style.display = "none";
    }

    resetConvo() {
      if (this.convoReq) this.convoReq.abort();
      this.convoReq = null;
      if (this.convoReveal) this.convoReveal.cancel();
      this.convoReveal = null;
      this.thread = [];
      this.storedTurns = [];
      this.convo.turns.textContent = "";
      this.enableConvo(false);
    }

    // Renders one exchange: the question, then the answer beneath it.
    addTurn(question) {
      const turn = el("div", "co-turn");
      const q = el("div", "co-turnq", question);
      const a = el("div", "co-body co-turna");
      const srcs = el("div", "co-srcs");
      const foot = el("div", "co-foot");
      turn.append(q, srcs, a, foot);
      this.convo.turns.append(turn);
      return { turn, a, srcs, foot };
    }

    // Replays stored turns after a reload: rendering only, never a request.
    replayTurns(turns) {
      for (const t of turns || []) {
        const ui = this.addTurn(t.q);
        renderMarkdown(ui.a, t.a);
        renderSources(ui.srcs, t.sources, t.queries);
        ui.foot.append(el("span", null, modelLabel(this.cfg.model) + " \u00b7 earlier in this conversation"));
        this.storedTurns.push({ q: t.q, sources: t.sources, queries: t.queries });
        this.thread.push({ role: "user", text: t.sent || t.q }, { role: "assistant", text: t.a });
      }
    }

    // storedTurns and thread stay index-aligned: thread[0..1] is the original
    // query and answer, and every later pair is one follow-up.
    persistTurns() {
      if (!this.threadKey) return;
      const turns = [];
      for (let i = 2; i < this.thread.length; i += 2) {
        const meta = this.storedTurns[(i - 2) / 2] || {};
        turns.push({
          q: meta.q,
          sent: this.thread[i].text,
          a: this.thread[i + 1] ? this.thread[i + 1].text : "",
          sources: meta.sources,
          queries: meta.queries,
        });
      }
      writeThread(this.threadKey, turns);
    }

    askFollowUp(text) {
      if (!this.thread.length) return;
      if (this.convoReq) this.convoReq.abort();
      const ui = this.addTurn(text);
      const caret = el("span", "co-caret");
      const status = el("span", "co-muted");
      ui.a.append(caret);
      ui.foot.append(status);

      const self = this;
      const t0 = Date.now();
      let acc = "";
      const prior = this.thread.slice();

      const reveal = makeReveal((shown, streaming) => {
        renderMarkdown(ui.a, shown);
        if (streaming) ui.a.append(caret);
      });
      this.convoReveal = reveal;

      this.convoReq = ask(
        this.cfg,
        {
          queued() {
            status.textContent = "waiting for the prompt cache";
          },
          searching(n) {
            status.textContent = "searching the web (" + n + ")";
          },
          fetching(n) {
            status.textContent = n === 1 ? "reading a page" : "reading pages (" + n + ")";
          },
          sources(list) {
            renderSources(ui.srcs, list, null);
          },
          delta(t) {
            status.textContent = "";
            acc += t;
            reveal.push(t);
          },
          done(info) {
            const settle = () => {
              caret.remove();
              renderSources(ui.srcs, info.sources, info.queries);
              const u = info.usage || {};
              const bits = [modelLabel(info.model)];
              if (info.cached) bits.push("from history");
              else {
                bits.push(((Date.now() - t0) / 1000).toFixed(1) + "s");
                if (u.output_tokens != null) bits.push(u.output_tokens + " out");
                // Worth surfacing on a follow-up specifically: it is the whole
                // point of the second cache breakpoint.
                if (u.cache_read_input_tokens) bits.push(u.cache_read_input_tokens + " cached in");
                if (info.cost) bits.push(fmtCost(info.cost));
              }
              ui.foot.textContent = "";
              ui.foot.append(el("span", null, bits.join(" \u00b7 ")));
              ui.foot.classList.add("co-fade");

              if (info.cost) paintSpend();
              self.storedTurns.push({ q: text, sources: info.sources, queries: info.queries });
              self.thread.push({ role: "user", text: info.sentUser }, { role: "assistant", text: acc });
              self.persistTurns();
              self.convoReq = null;
            };
            if (info.cached) {
              reveal.instant(acc);
              ui.a.classList.add("co-fade");
              settle();
            } else {
              reveal.finish(settle);
            }
          },
          error(message, needsKey) {
            reveal.cancel();
            caret.remove();
            ui.a.textContent = "";
            ui.a.append(el("div", "co-err", message));
            ui.foot.textContent = "";
            ui.foot.append(
              needsKey
                ? button("Settings", "co-run", openSettings)
                : button("Retry", "co-run", () => {
                    ui.turn.remove();
                    self.askFollowUp(text);
                  })
            );
            self.convoReq = null;
          },
        },
        false,
        { prior: prior, question: text, threadId: this.threadKey }
      );
    }

    run(force) {
      if (!query) return this.idle("No query detected.");
      this.stop();
      // A fresh first turn is a fresh conversation: the follow-ups below it
      // answered a different answer. Regenerate drops the stored thread too,
      // or a reload would replay turns that no longer follow from anything.
      if (force && this.threadKey) dropThread(this.threadKey);
      this.resetConvo();
      this.body.textContent = "";
      this.srcs.textContent = "";
      this.foot.textContent = "";

      const caret = el("span", "co-caret");
      const status = el("span", "co-muted");
      this.body.append(caret);
      this.foot.append(status);

      let acc = "";
      const t0 = Date.now();
      const self = this;

      // Renders whatever portion of the answer has been revealed so far, with
      // the caret trailing it while more is still coming.
      const reveal = makeReveal((text, streaming) => {
        renderMarkdown(self.body, text);
        if (streaming) self.body.append(caret);
      });
      this.reveal = reveal;

      this.req = ask(
        this.cfg,
        {
        queued() {
          status.textContent = "waiting for the prompt cache…";
        },
        searching(n) {
          status.textContent = "searching the web (" + n + ")…";
        },
        fetching(n) {
          status.textContent = n === 1 ? "reading a page\u2026" : "reading pages (" + n + ")\u2026";
        },
        sources(list) {
          renderSources(self.srcs, list, null);
        },
        delta(text) {
          status.textContent = "";
          acc += text;
          reveal.push(text);
        },
        done(info) {
          const settle = () => {
            caret.remove();
            renderSources(self.srcs, info.sources, info.queries);
            if (self.srcs.firstChild) self.srcs.firstChild.classList.add("co-fade");
            const u = info.usage || {};
            const bits = [modelLabel(info.model)];
            if (info.cached) bits.push("from history");
            else {
              bits.push(((Date.now() - t0) / 1000).toFixed(1) + "s");
              if (u.output_tokens != null) bits.push(u.output_tokens + " out");
              if (u.cache_read_input_tokens) bits.push(u.cache_read_input_tokens + " cached in");
              if (info.cost) bits.push(fmtCost(info.cost));
            }
            self.foot.textContent = "";
            const line = el("span", null, bits.join(" · "));
            self.foot.append(line, button("Regenerate", "co-run", () => self.run(true)));
            if (info.cost) paintSpend();
            self.foot.classList.add("co-fade");

            // The thread starts here: prior turns are replayed from storage
            // (render only, no request), then follow-ups extend it.
            self.thread = [
              { role: "user", text: info.sentUser },
              { role: "assistant", text: acc },
            ];
            // info.ph keys the thread to the prompt that produced its first
            // answer: editing the prompt starts a new conversation rather than
            // replaying turns that no longer follow from what is on screen.
            self.threadKey = info.sentUser
              ? [
                  self.cfg.model,
                  self.cfg.effort,
                  self.cfg.search ? "s" : "n",
                  info.ph || "",
                  hashStr(info.sentUser),
                ].join("|")
              : "";
            self.enableConvo(true);
            if (self.threadKey && !force) {
              readThread(self.threadKey, self.cfg.search).then((stored) => {
                if (stored && stored.turns && stored.turns.length && !self.convo.turns.firstChild) {
                  self.replayTurns(stored.turns);
                }
              });
            }
          };

          if (info.cached) {
            // Already on disk — show it at once and fade it in.
            reveal.instant(acc);
            self.body.classList.add("co-fade");
            settle();
          } else {
            // Let the reveal drain first so the footer does not appear before
            // the sentence it is describing.
            reveal.finish(settle);
          }
        },
        error(message, needsKey) {
          reveal.cancel();
          caret.remove();
          self.body.textContent = "";
          self.body.append(el("div", "co-err", message));
          self.foot.textContent = "";
          self.foot.append(
            needsKey
              ? button("Settings", "co-run", openSettings)
              : button("Retry", "co-run", () => self.run())
          );
          },
        },
        force
      );
    }
  }

  /* ---------- 9. Panel ---------- */
  function refreshChrome() {
    const many = columns.length > 1;
    ui.cols.classList.toggle("co-multi", many);
    ui.wrap.classList.toggle("co-single", !many);
    for (const c of columns) {
      c.setCloseVisible(many);
      const target = many ? c.root : ui.slot;
      if (c.head.parentElement !== target) {
        if (many) c.root.prepend(c.head);
        else target.append(c.head);
      }
    }
  }

  function addColumn(cfg, autoRun) {
    const c = new Column(cfg, ui.cols, (dead) => {
      const i = columns.indexOf(dead);
      if (i !== -1) columns.splice(i, 1);
      refreshChrome();
    });
    columns.push(c);
    refreshChrome();
    if (autoRun) c.run();
    return c;
  }

  const fmtLeft = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  async function paintCacheBar() {
    if (!ui) return;
    const now = Date.now();
    const warm = [];
    // Only entries written under the prompt currently in force can still be
    // read, so the bar counts those and ignores any left by an earlier edit.
    const stored = (await GM_.get("systemPrompt", DEFAULTS.systemPrompt)) || "";
    const ph = hashStr(stored.trim() || SYSTEM);
    for (const [id] of MODELS) {
      for (const s of [true, false]) {
        // Both results variants, because either may be the warm one - the
        // setting can change between queries within a single 5-minute TTL.
        for (const r of [true, false]) {
          const v = await GM_.get(prefixKey(id, s, ph, r), null);
          if (v && v.expires > now) warm.push(v);
        }
      }
    }
    warm.sort((a, b) => b.expires - a.expires);
    ui.cache.textContent = "";
    if (!warm.length) {
      const chip = el("span", "co-cachechip co-cachecold", "cache cold");
      chip.title = "Next query pays full price for the prompt prefix";
      ui.cache.append(chip);
      return;
    }
    const chip = el("span", "co-cachechip");
    chip.append(el("span", "co-cachedot"), fmtLeft(warm[0].expires - now));
    chip.title = warm
      .map(
        (v) =>
          modelLabel(v.model) +
          (v.search ? " + search" : "") +
          ": " +
          Math.round(v.tokens).toLocaleString() +
          " tokens cached, " +
          fmtLeft(v.expires - now) +
          " left"
      )
      .join("\n");
    ui.cache.append(chip);
  }

  /* Today and the last 30 days, summed from the local history log. Estimated
     from token counts rather than billed figures - it cannot see spend from
     other tools sharing the same key, and prices can change under it. */
  async function paintSpend() {
    if (!ui) return;
    const all = (await GM_.get("history", [])) || [];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayMs = startOfDay.getTime();
    const monthMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    let today = 0;
    let month = 0;
    let todayN = 0;
    for (const r of all) {
      const c = r.cost || 0;
      if (!c || !r.ts) continue;
      if (r.ts >= monthMs) month += c;
      if (r.ts >= dayMs) {
        today += c;
        todayN++;
      }
    }

    ui.spend.textContent = "";
    const chip = el("span", "co-spendchip", "$" + today.toFixed(1) + " today");
    chip.title =
      todayN +
      (todayN === 1 ? " answer today" : " answers today") +
      "\n" +
      fmtCost(month) +
      " over the last 30 days" +
      "\nEstimated from reported token usage, not from billing. Other tools using the same key are not counted.";
    ui.spend.append(chip);
  }

  function buildPanel(cfg) {
    const wrap = el("div", "co-panel");
    wrap.id = "claude-overview";

    const head = el("div", "co-head");
    const title = el("div", "co-title");
    title.append(el("span", "co-dot"), "Claude Overview");

    const toggle = button("", "co-toggle", async () => {
      const next = toggle.getAttribute("aria-pressed") !== "true";
      paintToggle(next);
      await GM_.set("enabled", next);
      for (const c of columns) (next ? c.run() : c.idle(OFF_TEXT));
    });
    // Compare lives on the panel's right edge and only surfaces on hover, so
    // the resting state is the answer and nothing else. Picking straight from
    // the menu means the new column arrives on the model you actually wanted,
    // instead of cloning the last one and making you change it after the fact.
    const compare = buildModelMenu(
      cfg,
      (model, effort) => {
        const base = columns[columns.length - 1];
        addColumn(Object.assign({}, base ? base.cfg : cfg, { model, effort }), true);
      },
      {
        glyph: "+",
        cls: "co-compare",
        showCurrent: false,
        title: "Compare another model side by side",
      }
    );
    const hist = button("↻", "co-chip", openHistory);
    hist.title = "History";
    const gear = button("⚙", "co-chip", openSettings);
    gear.title = "Settings";

    const slot = el("div", "co-slot");
    const cache = el("div", "co-cachebar");
    // Spend is the one number a user of a pay-per-query tool actually needs in
    // front of them. Computed locally from the usage each response reports.
    const spend = el("div", "co-spend");
    head.append(title, slot, spend, cache, hist, gear, toggle);

    const cols = el("div", "co-cols");
    wrap.append(head, cols, compare.root);
    ui = { wrap, toggle, cols, cache, slot, spend };

    /* "Auto" / "Manual" rather than "On" / "Off": the panel is present either
       way, and what this actually chooses is whether a query is answered the
       moment the page loads or only when you ask. "Off" read as though it
       disabled the whole thing, which it never did - the overview stays
       suppressed regardless. */
    function paintToggle(on) {
      toggle.setAttribute("aria-pressed", String(!!on));
      toggle.textContent = on ? "Auto" : "Manual";
      toggle.title = on
        ? "Answering automatically on every search"
        : "Answering only when you press Ask Claude";
    }
    paintToggle(cfg.enabled);

    paintCacheBar();
    setInterval(paintCacheBar, 1000);
    paintSpend();
    return wrap;
  }

  function mount(node) {
    // Preferred: the overview's own slot, so anything Google ranked above it
    // (a direct result, an official-site card) keeps its position.
    const found = findAIOverview(document);
    if (found) {
      const block = overviewUnit(found);
      if (block && block.parentElement && !block.contains(node)) {
        block.parentElement.insertBefore(node, block);
        block.remove();
        return true;
      }
    }

    // Fallback — no overview on the page, which is the normal case under
    // udm=14 since Google never generates one. Top of the results column.
    //
    // Only #center_col is acceptable. #rcnt is a CSS grid whose first track is
    // the narrow left rail, so a panel appended there becomes a grid item ~210px
    // wide with the text wrapping every few words. And at document-start
    // #center_col often does not exist yet, so returning false here is correct:
    // the observer simply tries again on the next mutation.
    const visible = (n) => {
      if (!n) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(n).display !== "none";
    };
    const host = [
      document.querySelector("#rcnt #center_col"),
      document.querySelector("#center_col"),
    ].find(visible);
    if (!host) return false;
    // #search sits below #center_col (currently #center_col > #gevUs > #search),
    // and insertBefore needs a direct child.
    let anchor = host.querySelector("#search");
    while (anchor && anchor.parentElement && anchor.parentElement !== host) {
      anchor = anchor.parentElement;
    }
    if (anchor && anchor.parentElement === host) host.insertBefore(node, anchor);
    else host.prepend(node);
    return true;
  }

  /* ---------- 10. Settings and history overlays ----------
     A userscript has no options page, so both are in-page modals. That matters
     for the API key: an <input> appended to google.com's DOM is readable by
     Google's own scripts and by anything else running on the page. Both modals
     are therefore built inside a CLOSED shadow root — `host.shadowRoot` is null
     from outside, so page script cannot traverse in and read the field. Styles
     go inside the root too, since page CSS does not cross the boundary. */
  function modal(titleText) {
    const host = el("div");
    host.id = "co-modal-host";
    // Positioned by the host so the shadow content needs no page CSS at all.
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647";
    document.documentElement.append(host);

    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = MODAL_CSS;
    root.append(style);

    const close = () => host.remove();
    const back = el("div", "co-modalback");
    const box = el("div", "co-modal");
    const head = el("div", "co-modalhead");
    head.append(el("div", "co-modaltitle", titleText), button("×", "co-close", close));
    const body = el("div", "co-modalbody");
    box.append(head, body);
    back.append(box);
    back.addEventListener("click", (e) => {
      if (e.target === back) close();
    });
    root.append(back);
    return { back, body, close, host };
  }

  // Validates a key without storing it, using count_tokens — which is free, so
  // checking costs nothing.
  function verifyKey(apiKey) {
    return new Promise((resolve) => {
      GM_.xhr({
        method: "POST",
        url: "https://api.anthropic.com/v1/messages/count_tokens",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        data: JSON.stringify({
          model: "claude-opus-5",
          messages: [{ role: "user", content: "hi" }],
        }),
        onload: (res) =>
          resolve(
            res.status === 200
              ? { ok: true }
              : { ok: false, status: res.status }
          ),
        onerror: () => resolve({ ok: false, status: 0 }),
      });
    });
  }

  async function openSettings() {
    const { body, close, back, host } = modal("Claude Overview — settings");
    const cur = {};
    for (const k of Object.keys(DEFAULTS)) cur[k] = await GM_.get(k, DEFAULTS[k]);

    const field = (label, node, note) => {
      const w = el("div", "co-field");
      w.append(el("label", null, label), node);
      if (note) w.append(el("div", "co-note", note));
      return w;
    };

    /* --- API key: write-only. The stored value is never rendered back into a
       field, so opening settings does not put the secret in the DOM at all. --- */
    const keyWrap = el("div");
    const status = el("div", "co-note");
    const keyRow = el("div", "co-histbar");

    const key = el("input");
    key.type = "password";
    key.placeholder = "sk-ant-...";
    key.autocomplete = "off";
    key.spellcheck = false;
    key.setAttribute("autocapitalize", "off");
    key.setAttribute("data-1p-ignore", "");  // don't let password managers store it

    const saveKey = button("Save key", "co-run", async () => {
      const v = key.value.trim();
      if (!v) return;
      status.textContent = "Checking…";
      const check = await verifyKey(v);
      if (!check.ok) {
        status.textContent =
          check.status === 401
            ? "Rejected: that key is not valid."
            : "Could not verify (" + (check.status || "network error") + "). Not saved.";
        return;
      }
      try {
        await GM_.set("apiKey", v);
      } catch (e) {
        status.textContent = "No userscript storage available — refusing to save a key here.";
        return;
      }
      key.value = "";           // never leave the secret sitting in the DOM
      await paintKeyState();
      for (const c of columns) c.run();
    });

    const clearKey = button("Remove", "co-chip", async () => {
      await GM_.set("apiKey", "");
      key.value = "";
      await paintKeyState();
    });

    keyRow.append(key, saveKey, clearKey);

    async function paintKeyState() {
      const saved = await GM_.get("apiKey", "");
      status.textContent = saved
        ? "A key is saved (" + saved.slice(0, 11) + "…" + saved.slice(-4) + "). Enter a new one to replace it."
        : hasGMStore()
        ? "No key saved."
        : "No userscript storage available — a key cannot be stored securely here.";
      clearKey.style.display = saved ? "" : "none";
    }
    await paintKeyState();

    keyWrap.append(keyRow, status);

    /* --- System prompt: the whole instruction block, editable. Prefilled with
       the current effective text rather than left blank, because an empty box
       under a label like this reads as "no prompt is being sent", which is not
       true — and because the default is the thing most edits start from. --- */
    const promptWrap = el("div");
    const promptBox = el("textarea", "co-prompt");
    promptBox.value = (cur.systemPrompt || "").trim() || SYSTEM;
    promptBox.rows = 14;
    promptBox.spellcheck = false;
    promptBox.setAttribute("aria-label", "System prompt");
    const promptState = el("div", "co-note");
    const resetPrompt = button("Reset to default", "co-chip", () => {
      promptBox.value = SYSTEM;
      paintPromptState();
    });

    function paintPromptState() {
      const v = promptBox.value.trim();
      const isDefault = !v || v === SYSTEM.trim();
      promptState.textContent = isDefault
        ? "Using the default prompt."
        : "Customised — " + v.split(/\s+/).length + " words. Clearing the box restores the default.";
      resetPrompt.style.display = isDefault ? "none" : "";
    }
    promptBox.addEventListener("input", paintPromptState);
    paintPromptState();

    const promptBar = el("div", "co-histbar");
    promptBar.append(resetPrompt);
    promptWrap.append(promptBox, promptState, promptBar);

    const resBox = el("input");
    resBox.type = "checkbox";
    resBox.checked = !!cur.results;
    const resRow = el("label", "co-check");
    resRow.append(resBox, document.createTextNode(" Send this page's search results with the query"));
    /* Shows the user the actual bytes, not a description of them - the same
       treatment the context field gets, and for the same reason: this is page
       content leaving the browser, so it should be inspectable before it does.
       Truncated because a full block runs to thousands of characters. */
    /* The whole parse, scrolling rather than truncated. This is the one place
       the user can audit exactly what leaves the browser, and an elided preview
       cannot answer the question it exists to answer - "is there anything in
       here I did not expect to send". */
    const resPreview = el("div", "co-note co-pre co-prescroll");
    (function paintResPreview() {
      const r = pageResults();
      if (!r) {
        resPreview.textContent =
          "No results detected on this page yet. Nothing would be sent.";
        return;
      }
      resPreview.textContent =
        r.count +
        (r.count === 1 ? " result extract" : " result extracts") +
        ", " +
        r.chars.toLocaleString() +
        " characters, sent exactly as below:\n\n" +
        r.text;
    })();

    const udm = el("input");
    udm.type = "checkbox";
    udm.checked = !!cur.udm14;
    const udmRow = el("label", "co-check");
    udmRow.append(udm, document.createTextNode(" Force Google web-only results (udm=14)"));

    const ctxBox = el("input");
    ctxBox.type = "checkbox";
    ctxBox.checked = !!cur.context;
    const ctxRow = el("label", "co-check");
    ctxRow.append(ctxBox, document.createTextNode(" Send local time and region with each query"));
    // Shows the user the exact bytes, not a description of them.
    const ctxPreview = el("div", "co-note co-pre", pageContext().text);

    body.append(
      field(
        "Anthropic API key",
        keyWrap,
        "Held by your userscript manager, never in this page's storage, and sent only to api.anthropic.com. " +
          "This dialog lives in a closed shadow root so page scripts cannot read the field. "
      ),
      field(
        "System prompt",
        promptWrap,
        "The instructions sent with every query."
      ),
      field(
        "User context",
        (() => {
          const w = el("div");
          w.append(ctxRow, ctxPreview);
          return w;
        })(),
        "Off by default. It lets Claude answer “near me”, “open now” and “today” questions properly. Note that udm=14 removes Google’s local results, so the location line is often the only local signal available."
      ),
      field(
        "Page results",
        (() => {
          const w = el("div");
          w.append(resRow, resPreview);
          return w;
        })(),
        "Off by default. Sends the results Google rendered on this page \u2014 each one exactly as shown, with its source, date, snippet and sitelinks \u2014 so Claude answers from the same evidence you can see. It rides in the message, after the prompt-cache breakpoint, so it costs nothing in cached prefix, but it is fresh input every query: roughly 600\u20133,000 extra tokens, capped at 12,000 characters. Google often renders destinations as abbreviated display URLs, and those are marked unlinkable so no answer invents an address from them."
      ),
      field(
        "Google results",
        udmRow,
        "The AI Overview is rendered inline in the search page, so there is no request to block. udm=14 is what stops Google generating it, but it also removes knowledge panels and image packs."
      )
    );

    /* Settings save on modification, not on Close. A dialog whose changes are
       lost unless you press the right button is a trap - and this one is worse
       than most, because closing it by clicking the backdrop or pressing Escape
       is the natural gesture and used to discard everything silently.

       Each control therefore owns its own persistence and its own consequence.
       `cur` is updated as we go, so it stays the record of what is stored and
       the "did this actually change" comparisons hold across several edits in
       one visit. */
    const savedNote = el("div", "co-note co-saved");

    // A re-run costs real money, so the note has to distinguish "stored" from
    // "stored, and your columns are re-answering because of it".
    let noteTimer = null;
    function flash(text) {
      savedNote.textContent = text;
      savedNote.classList.add("co-savedon");
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => savedNote.classList.remove("co-savedon"), 1800);
    }

    ctxBox.addEventListener("change", async () => {
      if (ctxBox.checked && !cur.context) primeGeo();
      cur.context = ctxBox.checked;
      await GM_.set("context", ctxBox.checked);
      // The context is part of the prompt, so a change invalidates every answer
      // on screen. Force, because the cache key it changes is the one that
      // would otherwise replay the same text back.
      for (const c of columns) c.run(true);
      flash("Saved. Re-answering with the new setting.");
    });

    resBox.addEventListener("change", async () => {
      cur.results = resBox.checked;
      await GM_.set("results", resBox.checked);
      // No force: the results signature is already part of the answer-cache
      // key, so the new shape misses on its own and switching back reuses the
      // old answer instead of re-billing for it.
      for (const c of columns) c.run();
      flash("Saved. Re-answering with the new setting.");
    });

    udm.addEventListener("change", async () => {
      cur.udm14 = udm.checked;
      await GM_.set("udm14", udm.checked);
      // Mirrored to localStorage so the document-start redirect can read it
      // synchronously. Not a secret - only the on/off flag.
      try {
        localStorage.setItem("co:udm14", JSON.stringify(udm.checked));
      } catch (e) {
        /* storage disabled */
      }
      // Nothing to re-run: this only changes what Google serves on the NEXT
      // search, so re-answering now would spend credits for no difference.
      flash("Saved. Applies to your next search.");
    });

    /* The prompt is a text field, so it gets the two-speed treatment: persist
       while typing (debounced, so a keystroke is not a storage write), but only
       re-answer once editing has actually stopped. Re-running per keystroke
       would bill a query for every pause. */
    function nextPromptValue() {
      const typed = promptBox.value.trim();
      // Store "" for the default so the built-in text stays live rather than
      // being frozen as a copy the moment the dialog is opened.
      return !typed || typed === SYSTEM.trim() ? "" : typed;
    }

    let promptTimer = null;
    async function savePrompt(rerun) {
      clearTimeout(promptTimer);
      const next = nextPromptValue();
      const changed = next !== ((cur.systemPrompt || "").trim());
      if (!changed) return;
      cur.systemPrompt = next;
      await GM_.set("systemPrompt", next);
      if (rerun) {
        // Without force, as above: the prompt hash is in the answer-cache key,
        // so reverting an edit costs nothing instead of re-billing every column.
        for (const c of columns) c.run();
        flash("Saved. Re-answering with the new prompt.");
      } else {
        flash("Saved.");
      }
    }

    promptBox.addEventListener("input", () => {
      paintPromptState();
      clearTimeout(promptTimer);
      promptTimer = setTimeout(() => savePrompt(false), 700);
    });
    // "change" fires on blur only when the value actually differs, which is the
    // natural "done editing" signal for a textarea.
    promptBox.addEventListener("change", () => savePrompt(true));

    // Reset writes straight through - it is a decision, not a keystroke.
    resetPrompt.addEventListener("click", () => savePrompt(true));

    /* Closing must not be able to lose a pending debounce: the dialog can go
       away by button, backdrop click or Escape, and only the first of those
       runs anything below. */
    const flush = () => {
      if (promptTimer) savePrompt(true);
    };
    back.addEventListener("click", (e) => {
      if (e.target === back) flush();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key !== "Escape") return;
      if (!host.isConnected) return void document.removeEventListener("keydown", onKey);
      flush();
    });

    const done = button("Close", "co-chip", () => {
      flush();
      close();
    });
    const closeRow = el("div", "co-histbar");
    closeRow.append(done, savedNote);
    body.append(closeRow);
  }

  async function openHistory() {
    const { body } = modal("Claude Overview — history");
    const all = (await GM_.get("history", [])) || [];

    const search = el("input");
    search.type = "search";
    search.placeholder = "Search queries and answers…";
    const count = el("div", "co-note");
    const list = el("div", "co-histlist");

    const exportBtn = button("Export JSON", "co-chip", () => {
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "claude-overview-history.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const clearBtn = button("Clear", "co-chip", async () => {
      if (!confirm("Delete all " + all.length + " history entries?")) return;
      await GM_.set("history", []);
      all.length = 0;
      draw();
    });

    function highlight(target, text, term) {
      if (!term) return void target.append(text);
      const lower = text.toLowerCase();
      const needle = term.toLowerCase();
      let i = 0;
      for (;;) {
        const hit = lower.indexOf(needle, i);
        if (hit === -1) break;
        if (hit > i) target.append(text.slice(i, hit));
        target.append(el("mark", null, text.slice(hit, hit + needle.length)));
        i = hit + needle.length;
      }
      target.append(text.slice(i));
    }

    function draw() {
      const term = search.value.trim();
      const rows = all.filter((r) => {
        if (!term) return true;
        return (r.query + "\n" + (r.answer || r.error || "")).toLowerCase().includes(term.toLowerCase());
      });
      count.textContent = rows.length + " of " + all.length + " entries";
      list.textContent = "";
      if (!rows.length) {
        list.append(el("div", "co-note", all.length ? "Nothing matches." : "No history yet."));
        return;
      }
      for (const r of rows.slice(0, 200)) {
        const row = el("div", "co-histrow");
        const q = el("div", "co-histq");
        if (r.followUp) q.append(el("span", "co-histfu", "\u21b3 "));
        highlight(q, r.query, term);
        const meta = el("div", "co-note");
        const parts = [new Date(r.ts).toLocaleString(), modelLabel(r.model)];
        // A follow-up on its own reads like an unrelated search ("and the
        // second one?"), so say what it was.
        if (r.followUp) parts.push("follow-up" + (r.turn ? " " + r.turn : ""));
        if (r.effort && !NO_EFFORT.has(r.model)) parts.push(r.effort);
        if (r.search) parts.push(r.searches ? r.searches + " searches" : "web search");
        if (r.ms) parts.push((r.ms / 1000).toFixed(1) + "s");
        if (r.usage && r.usage.output_tokens != null) parts.push(r.usage.output_tokens + " out");
        meta.textContent = parts.join(" · ");
        const ans = el("div", r.error ? "co-err" : "co-hista");
        highlight(ans, r.error || r.answer || "", term);
        row.append(q, meta, ans);
        list.append(row);
      }
    }

    search.addEventListener("input", draw);
    const bar = el("div", "co-histbar");
    bar.append(search, exportBtn, clearBtn);
    body.append(bar, count, list);
    draw();
  }

  GM_.menu("Claude Overview: settings", openSettings);
  GM_.menu("Claude Overview: history", openHistory);

  /* ---------- 11. Styles ---------- */
  // Page-level styles. The modal stylesheet is separate because it is
  // injected inside the closed shadow root, which page CSS cannot reach.
  const MODAL_CSS = `
/* Modals stay a distinct surface — they are chrome, not page content. */
.co-modalback{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;
 align-items:center;justify-content:center;font-family:Arial,sans-serif}
.co-modal{background:#fff;color:#202124;border-radius:12px;width:min(720px,92vw);max-height:86vh;
 display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.3)}
@media (prefers-color-scheme:dark){.co-modal{background:#2a2c33;color:#e8e8e8}}
.co-modalhead{display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid rgba(128,128,128,.28)}
.co-modaltitle{font-family:"Google Sans",Arial,sans-serif;font-size:16px;font-weight:500;margin-right:auto}
.co-modalhead .co-close{font-size:15px;line-height:1;padding:2px 8px;cursor:pointer;color:inherit;
 background:transparent;border:1px solid rgba(128,128,128,.28);border-radius:999px}
.co-modalbody{padding:16px;overflow:auto;font-size:14px;line-height:21px}
.co-modalbody input[type=text],.co-modalbody input[type=password],.co-modalbody input[type=search]{
 font:inherit;width:100%;padding:8px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;
 background:transparent;color:inherit}
.co-modalbody .co-run{font:inherit;font-size:14px;cursor:pointer;color:#fff;background:#1a73e8;
 border:0;border-radius:999px;padding:8px 18px}
.co-modalbody .co-chip{font:inherit;font-size:13px;cursor:pointer;color:inherit;background:transparent;
 border:1px solid rgba(128,128,128,.4);border-radius:999px;padding:6px 12px}
/* The prompt box is the one field where the text itself is the content, so it
   gets a monospace face and room to read a paragraph without scrolling. */
.co-modalbody textarea.co-prompt{
 font-family:monospace;font-size:12px;line-height:18px;width:100%;padding:10px;
 border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;
 resize:vertical;min-height:120px;white-space:pre-wrap}
.co-modalbody textarea.co-prompt:focus{outline:none;border-color:#1a73e8}
.co-field{margin-bottom:18px}
.co-field label{display:block;font-weight:500;margin-bottom:6px}
.co-note{font-size:12px;opacity:.7;margin-top:6px;line-height:18px}
.co-pre{white-space:pre-wrap;font-family:monospace;font-size:11px;line-height:16px;opacity:.8;
 border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:8px 10px;margin-top:8px}
/* The results parse runs to thousands of characters, so it scrolls in place
   instead of pushing the rest of the dialog off screen. overflow-wrap matters
   as much as the height: a long URL is one unbroken monospace token, and with
   no break opportunity it would widen the box and scroll the modal sideways. */
.co-prescroll{max-height:260px;overflow:auto;overflow-wrap:anywhere}
.co-check{display:flex;align-items:center;gap:8px;font-weight:400}
.co-check input{width:auto}
.co-histbar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
/* Confirmation that an edit was stored. Settings now save on change, so
   something has to say so - silence would read as "nothing happened". */
.co-saved{margin-top:0;opacity:0;transition:opacity .15s ease}
.co-savedon{opacity:.75}
@media (prefers-reduced-motion:reduce){.co-saved{transition:none}}
.co-histbar input{flex:1}
.co-histlist{display:flex;flex-direction:column}
.co-histrow{border-top:1px solid rgba(128,128,128,.28);padding:12px 0}
.co-histq{font-weight:700}
.co-histfu{opacity:.5;font-weight:400}
.co-hista{white-space:pre-wrap;margin-top:6px}
.co-modalbody mark{background:rgba(217,119,87,.35);color:inherit;border-radius:3px}
`;

  GM_.style(`
/* Blend with the SERP rather than sit on top of it: Google's result blocks are
   transparent and borderless, so the panel inherits the page's colour and font
   and marks its extent with the same hairline Google uses between blocks.
   Body copy matches a result snippet (16px/24px). */
#claude-overview {
  --co-accent: #d97757;              /* identity dot only */
  --co-line: rgba(128,128,128,.28);
  --co-link: #1a0dab;
  --co-active: #1a73e8;
  display: block;
  box-sizing: border-box;
  font-family: Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  color: inherit;
  background: transparent;
  max-width: 700px;
  margin: 0 0 26px;
  padding: 0 0 18px;
  border-bottom: 1px solid var(--co-line);
  position: relative;              /* positioning context for the compare rail */
}
#claude-overview * { box-sizing: border-box; font-family: inherit; }
@media (prefers-color-scheme: dark) {
  #claude-overview { --co-link: #99c3ff; --co-active: #8ab4f8; }
}

#claude-overview .co-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
}
#claude-overview .co-title {
  font-family: "Google Sans", Arial, sans-serif; font-size: 18px; line-height: 24px;
  display: flex; align-items: center; gap: 8px; color: inherit;
}
#claude-overview .co-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--co-accent); flex: none;
}

/* Google's own tab treatment rather than pills: no border, no radius, just a
   3px underline that fills in when the control is on. currentColor, not the
   blue, so an active control reads as emphasis of the text it sits in instead
   of a separate widget floating above the page.
   The compare rail is deliberately excluded — it is a floating affordance on
   the panel edge, not one of the header tabs, and keeps its pill. */
#claude-overview .co-chip,
#claude-overview .co-toggle,
#claude-overview .co-menuwrap:not(.co-compare) .co-menubtn {
  font-family: Arial, sans-serif; font-size: 12px; line-height: 18px;
  color: inherit; opacity: .7; background: transparent;
  border: 0; border-bottom: 3px solid transparent; border-radius: 0;
  padding: 3px 2px; cursor: pointer;
}
#claude-overview .co-chip:hover,
#claude-overview .co-toggle:hover,
#claude-overview .co-menuwrap:not(.co-compare) .co-menubtn:hover {
  opacity: 1; border-bottom-color: rgba(128,128,128,.4);
}
#claude-overview .co-close {
  font-family: Arial, sans-serif; font-size: 12px; line-height: 18px;
  color: inherit; opacity: .75; background: transparent;
  border: 1px solid var(--co-line); border-radius: 999px; padding: 2px 9px; cursor: pointer;
}
/* Toggles carry their state in a dot rather than by filling the whole pill:
   an outline when off, solid when on. Only the two controls that are actually
   toggles get one — the +/history/gear chips carry no aria-pressed, so the
   attribute selector leaves them alone. */
#claude-overview .co-toggle,
#claude-overview .co-chip[aria-pressed] {
  display: inline-flex; align-items: center; gap: 6px;
}
#claude-overview .co-toggle::before,
#claude-overview .co-chip[aria-pressed]::before {
  content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%;
  border: 1.5px solid currentColor; background: transparent;
}
#claude-overview .co-toggle[aria-pressed="true"],
#claude-overview .co-chip[aria-pressed="true"] {
  opacity: 1; border-bottom-color: currentColor;
}
#claude-overview .co-toggle[aria-pressed="true"]::before,
#claude-overview .co-chip[aria-pressed="true"]::before { background: currentColor; }
#claude-overview .co-toggle { margin-left: auto; }
#claude-overview.co-single .co-cachebar { margin-left: auto; }

/* Columns are separated by a rule rather than boxed in cards. */
#claude-overview .co-cols { display: block; }
#claude-overview .co-cols.co-multi {
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 1fr);
  gap: 20px; overflow-x: auto; padding-bottom: 4px;
}
#claude-overview .co-col { min-width: 0; }
#claude-overview .co-cols.co-multi .co-colhead { margin-bottom: 8px; }
#claude-overview .co-cols.co-multi .co-col {
  display: flex; flex-direction: column;
  padding-left: 14px; border-left: 1px solid var(--co-line);
}
#claude-overview .co-cols.co-multi .co-col:first-child { padding-left: 0; border-left: 0; }
#claude-overview .co-cols.co-multi .co-body { flex: 1 1 auto; }
#claude-overview .co-cols.co-multi .co-foot { margin-top: auto; }
#claude-overview .co-slot { display: contents; }
#claude-overview .co-colhead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
#claude-overview.co-single .co-colhead { display: contents; }
#claude-overview .co-close { margin-left: auto; font-size: 14px; line-height: 1; padding: 1px 7px; }

#claude-overview .co-body {
  white-space: pre-wrap; font-size: 16px; line-height: 24px; color: inherit;
}
#claude-overview .co-body strong { font-weight: 700; }
/* Google's result links: blue, underlined only on hover. */
#claude-overview .co-body a.co-link { color: var(--co-link); text-decoration: none; }
#claude-overview .co-body a.co-link:hover { text-decoration: underline; }
#claude-overview .co-body code {
  font-family: monospace; font-size: 14px;
  background: rgba(128,128,128,.16); padding: 1px 4px; border-radius: 4px;
}
#claude-overview .co-muted { opacity: .7; font-size: 14px; }
#claude-overview .co-err { color: #d93025; font-size: 14px; white-space: pre-wrap; }
@media (prefers-color-scheme: dark) { #claude-overview .co-err { color: #f28b82; } }
#claude-overview .co-caret {
  display: inline-block; width: 7px; height: 16px; vertical-align: -3px;
  background: var(--co-accent); animation: co-blink 1s steps(2) infinite;
}
@keyframes co-blink { 50% { opacity: 0 } }

#claude-overview .co-foot {
  margin-top: 12px; font-size: 12px; line-height: 18px; opacity: .75;
  display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
}
/* Google uses plain text buttons in link blue, not filled pills. */
#claude-overview .co-run {
  font-family: Arial, sans-serif; font-size: 13px; cursor: pointer;
  color: var(--co-link); background: transparent; border: 0; padding: 0;
}
#claude-overview .co-run:hover { text-decoration: underline; }

/* Model + effort picker. Anchored to its own wrapper so it opens under the
   button wherever the header wraps to. The panel is transparent chrome, but
   this popup is a surface that floats over result text, so it is the one place
   that gets an opaque background and a shadow. */
#claude-overview .co-menuwrap { position: relative; display: inline-flex; }
#claude-overview .co-menubtn {
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
#claude-overview .co-menucaret { font-size: 9px; opacity: .7; }
#claude-overview .co-menuwrap:not(.co-compare).co-menuopen .co-menubtn {
  opacity: 1; border-bottom-color: currentColor;
}
/* The rail is a floating control, so it keeps the pill it always had. */
#claude-overview .co-compare .co-menubtn {
  border: 1px solid var(--co-line); border-radius: 999px;
  color: inherit; opacity: .75; background: transparent; cursor: pointer;
}
#claude-overview .co-compare .co-menubtn:hover,
#claude-overview .co-compare.co-menuopen .co-menubtn { opacity: 1; }
#claude-overview .co-menu {
  display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 60;
  background: #fff; color: #202124;
  border: 1px solid var(--co-line); border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 6px;
  grid-template-columns: max-content max-content;
}
@media (prefers-color-scheme: dark) {
  #claude-overview .co-menu { background: #2a2c33; color: #e8e8e8; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
}
#claude-overview .co-menuwrap.co-menuopen .co-menu { display: grid; }
#claude-overview .co-menucol { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
#claude-overview .co-menuefforts {
  padding-left: 6px; margin-left: 6px; border-left: 1px solid var(--co-line);
}
#claude-overview .co-menuhead {
  font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
  opacity: .55; padding: 4px 8px 5px;
}
/* Flex, not grid: a grid row let the label column shrink and clipped "Max"
   to "M..". Here the label keeps its intrinsic width and the note is pushed
   to the right edge. */
#claude-overview .co-menuitem {
  display: flex; align-items: center; gap: 8px;
  width: 100%; text-align: left; font-family: Arial, sans-serif; font-size: 13px;
  line-height: 20px; color: inherit; background: transparent; border: 0;
  border-radius: 8px; padding: 6px 10px 6px 6px; cursor: pointer;
}
/* Hover and keyboard focus are the same state — the right column follows
   whichever one is active, so they must not look different. */
#claude-overview .co-menuitem:hover,
#claude-overview .co-menuitem:focus,
#claude-overview .co-menumodel.co-menuhot { background: rgba(128,128,128,.16); outline: none; }
#claude-overview .co-menuitem:focus-visible { box-shadow: inset 0 0 0 2px var(--co-active); }
#claude-overview .co-menucheck { flex: none; width: 14px; text-align: center; opacity: 0; font-size: 11px; }
#claude-overview .co-menuitem.co-menuon .co-menucheck { opacity: 1; color: var(--co-active); }
#claude-overview .co-menuitem.co-menuon .co-menucheck::before { content: "✓"; }
#claude-overview .co-menutext { flex: none; white-space: nowrap; }
#claude-overview .co-menueffort .co-menutext { text-transform: capitalize; }
#claude-overview .co-menunote { margin-left: auto; padding-left: 10px; font-size: 11px; opacity: .55; white-space: nowrap; }
#claude-overview .co-menuempty { font-size: 12px; opacity: .6; padding: 2px 8px 6px; max-width: 200px; line-height: 17px; }

/* Compare rail: a vertical pill on the panel's right edge, hidden until the
   overview is hovered so the resting state stays pure content. It also has to
   appear on keyboard focus (focus-within) or it would be unreachable without a
   pointer, and stay up while its own menu is open. */
/* A full-height strip, not just the pill. The pill alone was 74px tall and sat
   outside the panel's border box, so approaching it from any other height took
   the pointer through dead space: the panel stopped matching :hover and the
   pill faded out from under the cursor. The strip is a DOM child of the panel,
   and :hover propagates up the tree rather than by geometry, so entering it
   anywhere keeps the panel hovered. It overlaps the panel's right margin by
   8px so there is no gap to cross, and keeps pointer-events: none while hidden
   so it never eats a click on the page behind it. */
#claude-overview .co-compare {
  position: absolute; top: 0; bottom: 0; right: -22px; width: 30px;
  display: flex; align-items: center; justify-content: flex-end;
  opacity: 0; pointer-events: none; transition: opacity .12s ease;
}
#claude-overview:hover .co-compare,
#claude-overview:focus-within .co-compare,
#claude-overview .co-compare.co-menuopen { opacity: 1; pointer-events: auto; }
#claude-overview .co-compare .co-menubtn {
  width: 20px; height: 74px; padding: 0; border-radius: 999px;
  display: flex; align-items: center; justify-content: center;
}
#claude-overview .co-menuglyph { font-size: 13px; line-height: 1; }
/* Anchored to the rail, so it opens inward instead of off the page edge. */
#claude-overview .co-compare .co-menu { left: auto; right: calc(100% + 8px); top: 0; }
@media (prefers-reduced-motion: reduce) {
  #claude-overview .co-compare { transition: none; }
}

/* Conversation. Indented behind a hairline so the thread reads as attached to
   the answer above it rather than as a second, competing result block. */
#claude-overview .co-convo { margin-top: 14px; }
#claude-overview .co-turn {
  margin-top: 14px; padding-left: 14px; border-left: 2px solid var(--co-line);
}
#claude-overview .co-turnq {
  font-size: 15px; line-height: 22px; font-weight: 700; margin-bottom: 8px;
}
#claude-overview .co-turna { margin-top: 2px; }
#claude-overview .co-askform { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
#claude-overview .co-askinput {
  flex: 1 1 auto; min-width: 0; font-family: Arial, sans-serif; font-size: 14px;
  line-height: 22px; color: inherit; background: transparent;
  border: 0; border-bottom: 1px solid var(--co-line); border-radius: 0; padding: 4px 2px;
}
#claude-overview .co-askinput:focus { outline: none; border-bottom-color: currentColor; }
#claude-overview .co-opener { margin-top: 10px; }
/* In compare mode the columns are narrow, so the thread gives up its indent. */
#claude-overview .co-cols.co-multi .co-turn { padding-left: 10px; }
#claude-overview .co-cols.co-multi .co-turnq { font-size: 14px; line-height: 20px; }

#claude-overview .co-spend {
  display: flex; align-items: center; font-size: 12px; opacity: .7;
}
#claude-overview .co-spendchip { white-space: nowrap; }

#claude-overview .co-cachebar {
  display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 12px; opacity: .7;
}
#claude-overview .co-cachechip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 1px 8px; border-radius: 999px; border: 1px solid var(--co-line);
}
#claude-overview .co-cachedot {
  width: 6px; height: 6px; border-radius: 50%; background: #1e8e3e; flex: none;
}
#claude-overview .co-cachecold { opacity: .6; }

#claude-overview .co-srcs { margin-top: 12px; }
#claude-overview .co-pill {
  font-family: Arial, sans-serif; font-size: 12px; color: inherit; opacity: .8; cursor: pointer;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 3px 10px 3px 6px; border-radius: 999px;
  border: 1px solid var(--co-line); background: transparent;
}
#claude-overview .co-pill:hover { opacity: 1; }
#claude-overview .co-favs { display: inline-flex; }
#claude-overview .co-favs > * + * { margin-left: -4px; }
#claude-overview .co-fav {
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(128,128,128,.2); border: 1px solid var(--co-line);
  object-fit: cover; flex: none;
}
#claude-overview .co-favtxt {
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 700; opacity: .75;
}
#claude-overview .co-srclist {
  margin-top: 8px; display: flex; flex-direction: column; gap: 2px;
  max-height: 232px; overflow-y: auto;
}
#claude-overview .co-srcq { font-size: 12px; opacity: .7; margin-bottom: 6px; }
#claude-overview a.co-src {
  display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 8px;
  font-size: 14px; text-decoration: none; color: var(--co-link);
}
#claude-overview a.co-src:hover { background: rgba(128,128,128,.14); text-decoration: underline; }
#claude-overview .co-srct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#claude-overview .co-srch { opacity: .65; color: inherit; font-size: 12px; flex: none; }
/* Soft entrance for content that appears at once (cached answers, the source
   pill, the stats line) rather than being typed out. */
@keyframes co-fadein {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}
#claude-overview .co-fade { animation: co-fadein .22s ease-out both; }
/* The caret is the only motion that should survive reduced-motion, and even it
   stops blinking. */
@media (prefers-reduced-motion: reduce) {
  #claude-overview .co-fade { animation: none; }
  #claude-overview .co-caret { animation: none; opacity: .6; }
}
`);

  /* ---------- 12. Boot ---------- */
  (async () => {
    const cfg = {};
    for (const k of Object.keys(DEFAULTS)) cfg[k] = await GM_.get(k, DEFAULTS[k]);
    // Keep the synchronous mirror the document-start redirect reads in step 2.
    try {
      localStorage.setItem("co:udm14", JSON.stringify(!!cfg.udm14));
    } catch (e) {
      /* storage disabled */
    }

    // Only ask the browser for a fix when the user has opted into context at
    // all; with the setting off nothing about location is touched.
    if (cfg.context) primeGeo();

    const panel = buildPanel(cfg);
    const tryMount = () => {
      if (panel.isConnected) return true;
      if (!mount(panel)) return false;
      sweepAIOverview();
      const first = addColumn(cfg, false);
      if (cfg.enabled) first.run();
      else first.idle(OFF_TEXT);
      return true;
    };

    if (!tryMount()) {
      const mo = new MutationObserver(() => {
        if (tryMount()) mo.disconnect();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", tryMount, { once: true });
    }
  })();
})();
