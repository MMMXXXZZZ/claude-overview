"use strict";

// Firefox exposes the promise-based `browser` namespace; Chrome exposes `chrome`.
// Both support the subset used here, so bind whichever exists.
const api = globalThis.browser || globalThis.chrome;


/* ---------- 1. Inject the main-world request blocker as early as possible ---------- */
(() => {
  const s = document.createElement("script");
  s.src = api.runtime.getURL("inject.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).prepend(s);
})();

/* ---------- 2. Hide Google's AI Overview if any of it still renders ---------- */
// The selector list is best-effort; Google rotates these. The text sweep below is
// the durable half — these just prevent a flash before the sweep runs.
const AIO_SELECTORS = [
  "#m-x-content",
  "[data-attrid='SGE']",
  "[data-attrid='AIOverview']",
  "div[data-mcpr]",
  "[jsname='ANWQ7b']",
];
const AIO_LABELS = ["ai overview", "ai-powered overview"];

(() => {
  const style = document.createElement("style");
  style.textContent = AIO_SELECTORS.join(",") + "{display:none !important}";
  (document.head || document.documentElement).append(style);
})();

// Returns the AI Overview's own block without removing it — the caller needs
// its position. Google does not always put the overview first: on some queries
// a direct result renders above it.
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

// The detected block is the overview's content; its "Show more" control and a
// clipped wrapper reserving ~400px sit further up. Climb to take the whole
// unit, guarding hard against absorbing the results roots.
function overviewUnit(block) {
  const guards = ["#search", "#rso", "#center_col", "#rcnt", "#botstuff"]
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);
  let el = block;
  for (let i = 0; i < 10; i++) {
    const p = el.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    if (guards.some((g) => p === g || (p.contains(g) && !el.contains(g)))) break;
    if ([...p.querySelectorAll("a h3")].some((h) => !el.contains(h))) break;
    el = p;
  }
  return el;
}

// Take over the overview's slot rather than jumping to the top of the column.
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
    for (const n of m.addedNodes) {
      if (n.nodeType === 1) sweepAIOverview(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

/* ---------- 3. Config ---------- */
const DEFAULTS = {
  enabled: true,
  model: "claude-haiku-4-5",
  effort: "medium",
  search: true,
  context: false,
  results: false,
};
const MODELS = [
  ["claude-haiku-4-5", "Haiku 4.5"],
  ["claude-sonnet-5", "Sonnet 5"],
  ["claude-opus-5", "Opus 5"],
  ["claude-fable-5", "Fable 5"],
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Haiku 4.5 rejects output_config.effort outright, so the picker offers no
// effort levels for it rather than sending something the API will 400 on.
const NO_EFFORT = new Set(["claude-haiku-4-5"]);
// Shown in manual mode. It has to say that nothing is being spent AND that the
// overview is still gone, because those are the two things a reader looking at
// an empty panel actually wonders about.
const OFF_TEXT =
  "Manual \u2014 nothing is sent until you ask, and no credits are being spent. " +
  "Google's AI Overview stays blocked.";

const params = new URLSearchParams(location.search);
const query = params.get("q") || "";
// Only standard web results. Verticals (AI Mode udm=50, Images 2, Videos 7,
// News 12, Shopping 28, legacy tbm=) reuse /search with a different layout;
// AI Mode keeps a hidden #center_col, so the panel mounted invisibly and still
// billed a full query on every page load.
const udmParam = params.get("udm");
const IS_WEB_RESULTS =
  (udmParam === null || udmParam === "14") && !params.has("tbm");

/* ---------- 4. Small DOM helpers ---------- */
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
const effortsFor = (id) => (NO_EFFORT.has(id) ? [] : EFFORTS);

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

// Still never innerHTML: the anchor is built as an element and href assigned
// as a property, so nothing model-authored is parsed as markup. The scheme is
// checked anyway — an anchor is the one construct here that could execute.
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

// Deliberately minimal markdown: bold, inline code, links, line breaks.
// Everything is inserted as text nodes or built elements, never innerHTML, so
// model output can't inject markup.
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

/* ---------- 4b. Source pill ---------- */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return url;
  }
}

// Everything goes through wsrv.nl, so the browser only ever contacts that one
// host. It resolves the icon via DuckDuckGo's lookup (which discovers <link
// rel=icon>, not just /favicon.ico) and falls back to the site's own
// /favicon.ico server-side. Measured on a real source list: 5/11 for
// /favicon.ico alone, 13/14 for this chain.
function faviconFor(url) {
  const host = hostOf(url);
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
  // If the proxy or the site has no icon, fall back to a letter tile rather
  // than leaving a broken-image gap.
  img.addEventListener("error", () => {
    const letter = el("span", "co-fav co-favtxt", hostOf(url).charAt(0).toUpperCase());
    img.replaceWith(letter);
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
  // These are the pages Claude's searches returned, not a cited-sources list:
  // the API emits no citations for web_search results, so there is no way to
  // tell which ones actually informed the answer. Label them accordingly.
  pill.append(
    stack,
    el("span", null, sources.length + (sources.length === 1 ? " result" : " results"))
  );
  pill.setAttribute("aria-expanded", "false");
  if (queries && queries.length) {
    pill.title = "Searched: " + queries.join(" · ");
  }

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
    a.append(faviconFor(s.url), el("span", "co-srct", s.title));
    a.append(el("span", "co-srch", hostOf(s.url)));
    list.append(a);
  }

  container.append(pill, list);
}

function modelLabel(id) {
  const hit = MODELS.find((m) => m[0] === id);
  return hit ? hit[1] : id;
}

/* ---------- 4b. Page context ----------
   Per-request, so it is sent in the user message and never in the system
   block: the cache_control breakpoint sits on the system block, and anything
   varying placed before it would invalidate the ~6.2k-token prefix on every
   query.

   Off by default. With it on, every search sends Anthropic a rough location
   alongside the query; the options page spells out exactly what leaves. */
/* Structural, not class-based. Google's SERP class names are obfuscated and
   rotate (the measured ones were .Q8LRLc / .AhYzQb), so none appear here. Two
   properties that are not cosmetic do the work instead:

     - The location control is the only anchor in the footer that is a
       role="button" pointing at href="#": it opens a picker rather than
       navigating anywhere. Its first text leaf is the locality.
     - The country is the first visible leaf in the footer that is not inside a
       link at all - every other footer string (Help, Privacy, Terms, "Update
       location") is a link, and the hidden status strings have no layout box.

   Both survive a class rename and neither depends on interface language.
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
   navigator.permissions.query never prompts, so this looks before it leaps: on
   "granted" the fix is already the user's decision, on "prompt" nothing
   happens. A search page that suddenly raises a location dialog is
   indistinguishable from a hijack, so this must never cause one.

   Primed once at boot rather than awaited per request: a cold fix can take
   seconds and no answer should wait on the GPS. */
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
          /* revoked, or no fix available */
        },
        { enableHighAccuracy: false, maximumAge: 600000, timeout: 8000 }
      );
    })
    .catch(() => {
      /* permissions API without geolocation support */
    });
}

// Returns the block to prepend plus a coarse signature for the answer cache
// key. The signature omits the clock on purpose — otherwise every minute would
// be a fresh key and the cache would never hit.
function pageContext() {
  const now = new Date();
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) {
    /* older engine */
  }
  const gl = (params.get("gl") || "").toUpperCase();
  const hl = params.get("hl") || document.documentElement.lang || "";
  const place = googlePlace();

  const lines = [
    "Local time: " + now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }),
  ];
  if (tz) lines.push("Time zone: " + tz);
  if (place) lines.push("Location Google reports for this search: " + place);
  // ~110 m. Full precision would pin the user to a room for no gain.
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
    // Coordinates enter the signature rounded harder than they are sent
    // (~1 km), so walking down the street does not miss the cache.
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
   Sent only when the user turns it on. Like pageContext this rides in the USER
   MESSAGE, after the cache_control breakpoint, so it never invalidates the
   ~6.2k-token cached prefix.

   Structural, not class-based - Google's SERP class names are obfuscated and
   rotate (measured here: .zReHs / .yuRUbf / .kb0PBd). Three properties that are
   not cosmetic do the work instead, all verified against a live SERP on
   2026-09-06, both with and without udm=14:

     - An organic result is an anchor inside #rso containing an <h3>. This is
       the same signal overviewUnit() already trusts to avoid eating the results
       column, so if it ever breaks, more than this function is broken.
     - [data-hveid] is the result's own container: the nearest such ancestor of
       the anchor held exactly one <h3> and the whole rendered result - title,
       source name, date or comment count, snippet, sitelinks - and nothing else.
     - <cite> holds the displayed URL, or on social and video results the meta
       line instead ("4 comments - 5 years ago").

   The whole rendered text of each block is sent rather than parsed fields.
   Google puts dates in at least two different places (an "Aug 27, 2026 - "
   prefix on the snippet, or inside the cite meta line), and a parse that tries
   to normalise that loses more than it gains. */

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
  // Any google.com host here is a redirector (/goto, /url), not a destination.
  if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return null;
  return u.href;
}

// A rendered SERP runs to a few thousand characters; this bounds the worst case
// (expanded sitelinks on every result) so the feature cannot quietly multiply
// what a query costs. Measured on ordinary queries: about 2-4k.
const RESULTS_CHAR_CAP = 12000;

function pageResults() {
  try {
    const root = document.querySelector("#rso") || document.querySelector("#search");
    if (!root) return null;

    const seen = new Set();
    const entries = [];
    for (const a of root.querySelectorAll("a")) {
      if (!a.querySelector("h3")) continue;
      if (a.closest("#claude-overview")) continue; // never feed our own panel back
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
      // Keys the answer cache: a different result set must not replay an answer
      // that was built from the previous one.
      sig: hashStr(text),
    };
  } catch (e) {
    return null; // never let a SERP layout change break the request
  }
}

/* Results are rendered by Google's own scripts, so at document_start they are
   usually not in the DOM yet. Every path except the cold auto-run - the manual
   "Ask Claude" button, Regenerate, a follow-up - happens long after load and
   returns on the first line without waiting.

   The deadline is what makes this safe: a SERP that never populates #rso (a
   layout change, a consent interstitial) has to degrade to sending no results,
   not hang the panel with a caret blinking forever. */
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

// Sub-cent answers are the norm, so a two-decimal figure would read as $0.00
// for almost every query and tell the user nothing. The header total is
// coarser on purpose - see paintSpend.
const fmtCost = (c) =>
  "$" + (c >= 1 ? c.toFixed(2) : c >= 0.01 ? c.toFixed(3) : c.toFixed(4));

// Cheap, stable key material for a message list - not a security hash.
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* Threads are held by the background worker, not in google.com storage: a
   conversation is the user's, and the page origin is readable by Google. */
function threadGet(key) {
  // sendMessage returns a promise on MV3 and in Firefox, but not everywhere
  // (callback-style implementations and test shims return undefined), and an
  // unguarded .catch on undefined throws inside the done handler.
  try {
    const r = api.runtime.sendMessage({ type: "thread-get", key });
    return r && typeof r.then === "function" ? r.catch(() => null) : Promise.resolve(null);
  } catch (e) {
    return Promise.resolve(null);
  }
}
function threadPut(key, turns) {
  try {
    api.runtime.sendMessage({ type: "thread-put", key, turns });
  } catch (e) {
    /* worker asleep; the thread is still on screen */
  }
}
function threadDrop(key) {
  try {
    api.runtime.sendMessage({ type: "thread-drop", key });
  } catch (e) {
    /* nothing to drop */
  }
}

/* ---------- 5. Column: one model/effort combination ---------- */
class Column {
  constructor(cfg, host, onRemove) {
    this.cfg = { ...cfg };
    this.onRemove = onRemove;
    this.port = null;

    this.root = el("div", "co-col");
    // Kept as its own node so a single column can hoist it into the panel
    // header row instead of costing a second row of vertical space.
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

    head.append(this.menu.root, this.searchBtn);

    this.close = button("×", "co-close", () => this.destroy());
    head.append(this.close);

    // Per-column conversation. Each column keeps its own thread: a follow-up
    // asked here is answered here, so two columns can diverge deliberately.
    this.thread = [];
    this.storedTurns = [];
    this.threadKey = "";
    this.convoReq = false;
    this.convoReveal = null;
    this.body = el("div", "co-body");
    this.srcs = el("div", "co-srcs");
    this.foot = el("div", "co-foot");
    this.convo = this.buildConvo();
    // Sources sit ABOVE the answer: they say what the answer was built from,
    // which is context you want before reading it, not a footnote after.
    this.root.append(head, this.srcs, this.body, this.foot, this.convo.root);
    host.append(this.root);

    this.paintSearch();
    this.menu.paint();
  }

  // Only the first column persists settings; extra columns are scratch.
  get isPrimary() {
    return this.root.previousElementSibling === null;
  }

  persistIfPrimary() {
    if (!this.isPrimary) return;
    api.storage.sync.set({
      model: this.cfg.model,
      effort: this.cfg.effort,
      search: this.cfg.search,
    });
  }

  paintSearch() {
    this.searchBtn.setAttribute("aria-pressed", String(!!this.cfg.search));
    this.searchBtn.title = this.cfg.search ? "Web search on" : "Web search off";
  }

  setCloseVisible(v) {
    this.close.style.display = v ? "" : "none";
  }

  destroy() {
    this.disconnect();
    this.resetConvo();
    this.menu.close();
    this.root.remove();
    this.onRemove(this);
  }

  disconnect() {
    try {
      if (this.port) this.port.disconnect();
    } catch (e) {
      /* already gone */
    }
    this.port = null;
  }

  idle(msg) {
    this.disconnect();
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

  enableConvo(on) {
    this.convo.opener.style.display = on ? "" : "none";
    if (!on) this.convo.form.style.display = "none";
  }

  resetConvo() {
    if (this.convoPort) {
      try {
        this.convoPort.disconnect();
      } catch (e) {
        /* already gone */
      }
    }
    this.convoPort = null;
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
    threadPut(this.threadKey, turns);
  }

  askFollowUp(text) {
    if (!this.thread.length) return;
    if (this.convoPort) {
      try {
        this.convoPort.disconnect();
      } catch (e) {
        /* already gone */
      }
    }
    const ui = this.addTurn(text);
    const caret = el("span", "co-caret");
    const status = el("span", "co-muted");
    ui.a.append(caret);
    ui.foot.append(status);

    let acc = "";
    const started = performance.now();
    const prior = this.thread.slice();
    const port = api.runtime.connect({ name: "claude-overview" });
    this.convoPort = port;

    port.onMessage.addListener((msg) => {
      if (msg.type === "queued") {
        status.textContent = "waiting for the prompt cache";
      } else if (msg.type === "fetching") {
        status.textContent =
          msg.n === 1 ? "reading a page" : "reading pages (" + msg.n + ")";
      } else if (msg.type === "searching") {
        status.textContent = msg.query
          ? "searched: " + msg.query
          : "searching the web (" + msg.n + ")";
      } else if (msg.type === "sources") {
        renderSources(ui.srcs, msg.sources, null);
      } else if (msg.type === "delta") {
        status.textContent = "";
        acc += msg.text;
        renderMarkdown(ui.a, acc);
        ui.a.append(caret);
      } else if (msg.type === "done") {
        caret.remove();
        renderMarkdown(ui.a, acc);
        renderSources(ui.srcs, msg.sources, msg.queries);
        ui.foot.textContent = "";
        const u = msg.usage || {};
        const bits = [modelLabel(msg.model)];
        if (msg.cached) bits.push("from history");
        else {
          bits.push(((performance.now() - started) / 1000).toFixed(1) + "s");
          if (u.output_tokens != null) bits.push(u.output_tokens + " out");
          // Worth surfacing on a follow-up specifically: it is the whole point
          // of the second cache breakpoint.
          if (u.cache_read_input_tokens) bits.push(u.cache_read_input_tokens + " cached in");
          if (msg.cost) bits.push(fmtCost(msg.cost));
        }
        ui.foot.append(el("span", null, bits.join(" \u00b7 ")));
        if (msg.cost) paintSpend();
        this.storedTurns.push({ q: text, sources: msg.sources, queries: msg.queries });
        this.thread.push({ role: "user", text: msg.sentUser }, { role: "assistant", text: acc });
        this.persistTurns();
        this.convoPort = null;
      } else if (msg.type === "error") {
        caret.remove();
        ui.a.textContent = "";
        ui.a.append(el("div", "co-err", msg.message));
        ui.foot.textContent = "";
        ui.foot.append(
          msg.needsKey
            ? button("Add API key", "co-run", () => api.runtime.sendMessage({ type: "open-options" }))
            : button("Retry", "co-run", () => {
                ui.turn.remove();
                this.askFollowUp(text);
              })
        );
        this.convoPort = null;
      }
    });

    port.postMessage({
      type: "ask",
      query,
      model: this.cfg.model,
      effort: this.cfg.effort,
      search: this.cfg.search,
      context: null, // rides on the first turn only
      prior,
      question: text,
      threadId: this.threadKey,
    });
  }

  async run() {
    if (!query) return this.idle("No query detected.");
    this.disconnect();
    // A fresh first turn is a fresh conversation: the follow-ups below it
    // answered a different answer.
    if (this.threadKey) threadDrop(this.threadKey);
    this.resetConvo();
    this.foot.textContent = "";
    this.body.textContent = "";
    this.srcs.textContent = "";

    const caret = el("span", "co-caret");
    const status = el("span", "co-muted");
    this.body.append(caret);
    this.foot.append(status);

    let acc = "";
    const started = performance.now();
    const port = api.runtime.connect({ name: "claude-overview" });
    this.port = port;

    port.onMessage.addListener((msg) => {
      if (msg.type === "queued") {
        status.textContent = "waiting for the prompt cache…";
      } else if (msg.type === "fetching") {
        status.textContent =
          msg.n === 1 ? "reading a page\u2026" : "reading pages (" + msg.n + ")\u2026";
      } else if (msg.type === "searching") {
        status.textContent = msg.query
          ? "searched: " + msg.query
          : "searching the web (" + msg.n + ")…";
      } else if (msg.type === "sources") {
        renderSources(this.srcs, msg.sources, null);
      } else if (msg.type === "delta") {
        status.textContent = "";
        acc += msg.text;
        renderMarkdown(this.body, acc);
        this.body.append(caret);
      } else if (msg.type === "done") {
        caret.remove();
        renderMarkdown(this.body, acc);
        renderSources(this.srcs, msg.sources, msg.queries);
        this.foot.textContent = "";
        const u = msg.usage || {};
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        const bits = [modelLabel(msg.model)];
        if (msg.cached) bits.push("from history");
        else {
          bits.push(secs + "s");
          if (u.output_tokens != null) bits.push(u.output_tokens + " out");
          if (u.cache_read_input_tokens) {
            bits.push(u.cache_read_input_tokens + " cached in");
          }
          if (msg.cost) bits.push(fmtCost(msg.cost));
        }
        this.foot.append(el("span", null, bits.join(" · ")));
        this.foot.append(button("Regenerate", "co-run", () => this.run()));
        if (msg.cost) paintSpend();

        // The thread starts here: prior turns are replayed from storage
        // (render only, no request), then follow-ups extend it.
        this.thread = [
          { role: "user", text: msg.sentUser },
          { role: "assistant", text: acc },
        ];
        this.threadKey = msg.sentUser
          ? [this.cfg.model, this.cfg.effort, this.cfg.search ? "s" : "n", hashStr(msg.sentUser)].join("|")
          : "";
        this.enableConvo(true);
        if (this.threadKey) {
          threadGet(this.threadKey).then((stored) => {
            if (stored && stored.turns && stored.turns.length && !this.convo.turns.firstChild) {
              this.replayTurns(stored.turns);
            }
          });
        }
      } else if (msg.type === "error") {
        caret.remove();
        this.body.textContent = "";
        this.body.append(el("div", "co-err", msg.message));
        this.foot.textContent = "";
        this.foot.append(
          msg.needsKey
            ? button("Add API key", "co-run", () =>
                api.runtime.sendMessage({ type: "open-options" })
              )
            : button("Retry", "co-run", () => this.run())
        );
      }
    });

    // Both are built here because the service worker has no page to read.
    // Results may need to wait for Google to render them, so the port is opened
    // first (the caret is already on screen) and the request posted after.
    const results = this.cfg.results ? await awaitResults() : null;
    // The wait is long enough for the column to have been torn down under us -
    // toggled to manual, model changed, tab closed. Posting to a disconnected
    // port would throw and, worse, bill a query nobody is waiting for.
    if (this.port !== port) return;

    port.postMessage({
      type: "ask",
      query,
      model: this.cfg.model,
      effort: this.cfg.effort,
      search: this.cfg.search,
      context: this.cfg.context ? pageContext() : null,
      results,
    });
  }
}

/* ---------- 6. Panel ---------- */
const columns = [];
let ui = null;

function refreshColumnChrome() {
  const many = columns.length > 1;
  ui.cols.classList.toggle("co-multi", many);
  ui.wrap.classList.toggle("co-single", !many);
  for (const c of columns) {
    c.setCloseVisible(many);
    // One column: hoist its controls into the header row. More than one: each
    // column carries its own controls again.
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
    refreshColumnChrome();
  });
  columns.push(c);
  refreshColumnChrome();
  if (autoRun) c.run();
  return c;
}

/* ---------- 5b. Prompt-cache countdown ---------- */
function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/* Today and the last 30 days, summed from the local history log. Estimated
   from token counts rather than billed figures - it cannot see spend from
   other tools sharing the same key, and prices can change under it. */
async function paintSpend() {
  if (!ui) return;
  const { history = [] } = await api.storage.local.get("history");
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dayMs = startOfDay.getTime();
  const monthMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  let today = 0;
  let month = 0;
  let todayN = 0;
  for (const r of history) {
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

async function paintCacheBar() {
  if (!ui) return;
  const all = await api.storage.session.get(null);
  const now = Date.now();
  const warm = Object.entries(all)
    .filter(([k, v]) => k.startsWith("cw:") && v && v.expires > now)
    .map(([, v]) => v)
    .sort((a, b) => b.expires - a.expires);

  ui.cache.textContent = "";
  if (!warm.length) {
    const chip = el("span", "co-cachechip co-cachecold", "cache cold");
    chip.title = "Next query pays full price for the prompt prefix";
    ui.cache.append(chip);
    return;
  }
  // One chip, showing the longest-lived prefix; details go in the tooltip so
  // the header stays on a single row.
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
    .join(String.fromCharCode(10));
  ui.cache.append(chip);
}

function startCacheTicker() {
  paintCacheBar();
  setInterval(paintCacheBar, 1000);
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
    await api.storage.sync.set({ enabled: next });
    if (next) for (const c of columns) c.run();
    else for (const c of columns) c.idle(OFF_TEXT);
  });

  // Compare lives on the panel's right edge and only surfaces on hover, so the
  // resting state is the answer and nothing else. Picking straight from the
  // menu means the new column arrives on the model you actually wanted instead
  // of cloning the last one.
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
  const history = button("↻", "co-chip", () =>
    api.runtime.sendMessage({ type: "open-history" })
  );
  history.title = "History";

  head.append(title);

  const slot = el("div", "co-slot");
  const cache = el("div", "co-cachebar");
  // Spend is the one number a user of a pay-per-query tool actually needs in
  // front of them. Computed locally from the usage each response reports.
  const spend = el("div", "co-spend");
  head.append(slot, spend, cache, history, toggle);

  const cols = el("div", "co-cols");
  wrap.append(head, cols, compare.root);

  ui = { wrap, toggle, cols, cache, slot, spend };
  startCacheTicker();
  paintSpend();

  // "Auto" / "Manual" rather than "On" / "Off": the panel is present either
  // way, and what the control actually chooses is whether a query is answered
  // the moment the page loads or only when you ask for it. "Off" read as though
  // it disabled the extension, which it never did.
  function paintToggle(on) {
    toggle.setAttribute("aria-pressed", String(!!on));
    toggle.textContent = on ? "Auto" : "Manual";
    toggle.title = on
      ? "Answering automatically on every search"
      : "Answering only when you press Ask Claude";
  }
  paintToggle(cfg.enabled);

  return wrap;
}

function mount(node) {
  // Preferred: the overview's own slot, so anything Google ranked above it
  // keeps its position. Falls back to the top of the results column, which is
  // the normal case under udm=14 (no overview is generated at all).
  const found = findAIOverview(document);
  if (found) {
    const block = overviewUnit(found);
    if (block && block.parentElement && !block.contains(node)) {
      block.parentElement.insertBefore(node, block);
      block.remove();
      return true;
    }
  }

  // Only #center_col is acceptable. #rcnt is a CSS grid whose first track is
  // the narrow left rail, so a panel appended there becomes a grid item ~210px
  // wide with text wrapping every few words. At document_start #center_col
  // often does not exist yet — returning false is correct, the observer retries.
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

  // #search is a descendant of #center_col, not a direct child (currently
  // #center_col > #gevUs > #search), so climb to the child of host that
  // contains it — insertBefore requires a direct child.
  let anchor = host.querySelector("#search");
  while (anchor && anchor.parentElement && anchor.parentElement !== host) {
    anchor = anchor.parentElement;
  }
  if (anchor && anchor.parentElement === host) host.insertBefore(node, anchor);
  else host.prepend(node);
  return true;
}

/* ---------- 7. Boot ---------- */
(async () => {
  if (!IS_WEB_RESULTS) return;
  const cfg = Object.assign({}, DEFAULTS, await api.storage.sync.get(DEFAULTS));
  // Only ask the browser for a fix when the user opted into context at all.
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
