"use strict";

// Firefox exposes the promise-based `browser` namespace; Chrome exposes `chrome`.
// Both support the subset used here, so bind whichever exists.
const api = globalThis.browser || globalThis.chrome;


const $ = (id) => document.getElementById(id);
let ALL = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const MODEL_LABELS = {
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5": "Fable 5",
};
const label = (m) => MODEL_LABELS[m] || m;

// Append text to `target`, wrapping case-insensitive matches of `term` in
// <mark>. Text nodes only — history content is never treated as markup.
function appendHighlighted(target, text, term) {
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

function fmtWhen(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
}

function render() {
  const term = $("q").value.trim();
  const fm = $("model").value;
  const fe = $("effort").value;
  const fs = $("search").value;

  const rows = ALL.filter((r) => {
    if (fm && r.model !== fm) return false;
    if (fe && r.effort !== fe) return false;
    if (fs === "1" && !r.search) return false;
    if (fs === "0" && r.search) return false;
    if (!term) return true;
    const hay = (r.query + "\n" + (r.answer || r.error || "")).toLowerCase();
    return hay.includes(term.toLowerCase());
  });

  $("count").textContent =
    rows.length + " of " + ALL.length + " entries" +
    (ALL.length >= 1000 ? " (capped at 1000)" : "");

  const list = $("list");
  list.textContent = "";
  if (!rows.length) {
    list.append(
      el("div", "empty", ALL.length ? "Nothing matches those filters." : "No history yet.")
    );
    return;
  }

  for (const r of rows) {
    const row = el("div", "row");
    const q = el("div", "q");
    // A follow-up on its own reads like an unrelated search ("and the second
    // one?"), so mark it and say which turn it was.
    if (r.followUp) {
      const arrow = el("span", "fu");
      arrow.textContent = "↳ ";
      q.append(arrow);
    }
    appendHighlighted(q, r.query, term);

    const meta = el("div", "meta");
    meta.append(el("span", null, fmtWhen(r.ts)));
    meta.append(el("span", "tag", label(r.model)));
    if (r.followUp) meta.append(el("span", "tag", "follow-up" + (r.turn ? " " + r.turn : "")));
    if (r.effort && r.model !== "claude-haiku-4-5") {
      meta.append(el("span", "tag", r.effort));
    }
    if (r.search) {
      meta.append(
        el("span", "tag", r.searches ? r.searches + " searches" : "web search")
      );
    }
    if (r.ms) meta.append(el("span", null, (r.ms / 1000).toFixed(1) + "s"));
    const u = r.usage || {};
    if (u.output_tokens != null) {
      meta.append(el("span", null, u.output_tokens + " out"));
    }
    if (u.cache_read_input_tokens) {
      meta.append(
        el("span", null, u.cache_read_input_tokens.toLocaleString() + " cached in")
      );
    }

    const body = el("div", r.error ? "err" : "a");
    appendHighlighted(body, r.error || r.answer || "", term);

    row.append(q, meta, body);
    list.append(row);
  }
}

async function load() {
  const { history = [] } = await api.storage.local.get("history");
  ALL = history;

  // Populate filter dropdowns from what's actually present.
  const models = [...new Set(ALL.map((r) => r.model))];
  for (const m of models) {
    const o = el("option", null, label(m));
    o.value = m;
    $("model").append(o);
  }
  const efforts = [...new Set(ALL.map((r) => r.effort).filter(Boolean))];
  for (const e of efforts) {
    const o = el("option", null, e);
    o.value = e;
    $("effort").append(o);
  }
  render();
}

for (const id of ["q", "model", "effort", "search"]) {
  $(id).addEventListener("input", render);
  $(id).addEventListener("change", render);
}

$("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(ALL, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "claude-overview-history.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all " + ALL.length + " history entries? This cannot be undone."))
    return;
  await api.storage.local.set({ history: [] });
  ALL = [];
  render();
});

load();
