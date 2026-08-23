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
    udm14: true,
  });
  const local = await api.storage.local.get("apiKey");
  $("model").value = sync.model;
  $("effort").value = sync.effort;
  $("enabled").checked = sync.enabled;
  $("search").checked = sync.search;
  $("context").checked = sync.context;
  $("udm14").checked = sync.udm14;
  // Write-only: never render the stored secret back into the field.
  const k = local.apiKey || "";
  $("keystate").textContent = k
    ? "A key is saved (" + k.slice(0, 11) + "…" + k.slice(-4) + "). Enter a new one to replace it."
    : "No key saved.";
})();

$("save").addEventListener("click", async () => {
  await api.storage.sync.set({
    model: $("model").value,
    effort: $("effort").value,
    enabled: $("enabled").checked,
    search: $("search").checked,
    context: $("context").checked,
    udm14: $("udm14").checked,
  });
  // Only overwrite the key when a new one was actually typed.
  const typed = $("key").value.trim();
  if (typed) {
    await api.storage.local.set({ apiKey: typed });
    $("key").value = "";
  }
  $("status").textContent = "Saved";
  setTimeout(() => ($("status").textContent = ""), 1600);
});
