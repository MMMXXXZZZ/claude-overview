"use strict";

// Firefox exposes the promise-based `browser` namespace; Chrome exposes `chrome`.
// Both support the subset used here, so bind whichever exists.
const api = globalThis.browser || globalThis.chrome;


const $ = (id) => document.getElementById(id);

(async () => {
  const sync = await api.storage.sync.get({
    model: "claude-opus-5",
    effort: "medium",
    enabled: true,
    search: true,
    context: false,
    results: false,
    udm14: true,
  });
  const local = await api.storage.local.get("apiKey");
  $("model").value = sync.model;
  $("effort").value = sync.effort;
  $("enabled").checked = sync.enabled;
  $("search").checked = sync.search;
  $("context").checked = sync.context;
  $("results").checked = sync.results;
  $("udm14").checked = sync.udm14;
  // Write-only: never render the stored secret back into the field.
  const k = local.apiKey || "";
  $("keystate").textContent = k
    ? "A key is saved (" + k.slice(0, 11) + "…" + k.slice(-4) + "). Enter a new one to replace it."
    : "No key saved.";
})();

/* Settings save on modification rather than on a Save press. A preferences
   page whose changes vanish unless you find the right button is a trap, and
   closing the tab is the natural way to leave one.

   The API key is the deliberate exception: it is write-only and only ever
   overwritten when something was actually typed, so it keeps an explicit
   button. Saving a secret on every keystroke would persist half-typed keys. */
const SETTINGS = ["model", "effort", "enabled", "search", "context", "results", "udm14"];

let statusTimer = null;
function flash(text) {
  $("status").textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1600);
}

async function persist() {
  await api.storage.sync.set({
    model: $("model").value,
    effort: $("effort").value,
    enabled: $("enabled").checked,
    search: $("search").checked,
    context: $("context").checked,
    results: $("results").checked,
    udm14: $("udm14").checked,
  });
  flash("Saved");
}

for (const id of SETTINGS) {
  // "change" rather than "input": for checkboxes and selects they are the same
  // moment, and it avoids writing storage on every arrow-key pass through a
  // select the user is still scrolling.
  $(id).addEventListener("change", persist);
}

$("save").addEventListener("click", async () => {
  const typed = $("key").value.trim();
  if (!typed) return void flash("Enter a key first");
  await api.storage.local.set({ apiKey: typed });
  $("key").value = ""; // never leave the secret sitting in the DOM
  flash("Key saved");
});
