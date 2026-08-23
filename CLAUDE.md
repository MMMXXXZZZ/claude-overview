# CLAUDE.md

Context for working on this repo. Read this first, then follow the rule below.

## Mandatory: read the whole script before editing it

**Before making any change to `claude-overview.user.js`, read the entire file
(all ~1700 lines) in one pass.** Not a grep, not a section — the whole thing.

This is not ceremony. The file is one IIFE where distant parts are coupled in
ways a targeted search will not reveal, and every one of these has already
caused a real bug here:

- `makeReveal` schedules `requestAnimationFrame`; the cached path calls both
  `push()` and `instant()`. Editing one without seeing the other left the caret
  blinking forever after a cached answer.
- `mount()`, `findAIOverview()` and `overviewUnit()` decide placement together.
  Changing the climb in isolation once deleted the entire results page.
- The prefix gate (`acquirePrefix`) must be released on every exit path —
  stream end, HTTP error, network error, abort. Miss one and every other tab
  blocks for 30 seconds.
- `MODAL_CSS` is defined *after* `modal()` uses it (fine at runtime, since the
  call happens on click). Moving code without knowing that breaks it.
- `GM_` shim, `SECRETS`, and the settings dialog together are what keep the API
  key off the page origin.

The same applies to `extension/content.js` and `extension/background.js` when
touching those. **The two builds are kept behaviourally in sync** — a fix in one
almost always belongs in the other.

## What this is

Replaces Google's AI Overview with an answer from Claude, in the same slot.

Two builds of the same tool:

| Path | Role |
|---|---|
| `claude-overview.user.js` | **Primary.** The userscript the user actually runs (Tampermonkey on Firefox). Self-contained. |
| `claude-overview.dev.user.js` | Metadata-only loader; `@require`s the above over HTTP for a no-reinstall edit loop. |
| `dev-server.mjs` | Serves the repo on `127.0.0.1:8777` with `no-store`. Required by the dev loader. |
| `extension/` | Same tool as an MV3 extension (Chrome/Firefox). Kept in sync; not what the user runs. |
| `test/` | Fixture + shims for exercising the panel without a browser extension. |

The user runs **Firefox + Tampermonkey**. Test findings from Chrome do not
automatically transfer — see Streaming below.

## Hard-won facts (do not re-derive these)

**The AI Overview cannot be blocked at the network layer.** It is rendered
inline in the initial `/search` document. There is no `/async/aion` request, so
request-blocking rules accomplish nothing. `udm=14` (Google's web-only mode) is
the only thing that stops Google generating it. It also removes knowledge panels
and image packs, hence the toggle.

**The query still reaches Google.** It is the search. Only the overview
generation is prevented. Never claim otherwise.

**Placement.** The overview lives *inside* `#search` and is not always first —
some queries rank a direct result above it. The panel takes the overview's own
slot rather than the top of the column. Removal climbs to the unit that owns the
"Show more" control and a ~400px clipped wrapper, guarded against absorbing
`#search`, `#rso`, `#center_col`, `#rcnt`, `#botstuff`.

**Never mount into `#rcnt`.** It is a CSS grid; a panel appended there becomes a
grid item in the narrow left rail (~210px) with text wrapping every few words.
Only `#center_col` is acceptable. At `document-start` it often does not exist
yet — returning `false` and letting the MutationObserver retry is correct.

**Only standard web results.** Bail unless `udm` is absent or `14`, and no
`tbm`. Verticals reuse `/search` with different layouts; AI Mode (`udm=50`)
keeps a hidden `#center_col`, so the panel mounted invisibly *and still billed a
full query on every page load*.

**Streaming differs by manager.** Chrome-side managers and Violentmonkey grow
`responseText` during `onprogress`. **Tampermonkey on Firefox does not** — it
buffers and delivers at `onload`. Its streaming path is
`responseType: "stream"` (ReadableStream on `onloadstart`). Both are
implemented, plus a paced reveal that makes either look the same.

**`@require file://` does not work in Firefox.** Extensions cannot read
`file://`. Hence the HTTP dev server, which must send `no-store` because
Tampermonkey caches `@require` resources.

## API specifics

Current param shapes (verified against the live API — do not revert to older
recalled forms):

- `thinking: {type: "adaptive"}`, `output_config: {effort: "low".."max"}`.
- Header `anthropic-dangerous-direct-browser-access: true` is required from a
  browser context.
- **Haiku 4.5 rejects `output_config.effort`** — the control is disabled for it.
- **Fable 5 rejects an explicit `thinking` config** — omit it.
- `web_search_20260209` is limited to newer models; others need
  `web_search_20250305`. See `MODEL_RULES`.
- The dynamic-filtering search variant runs its searches from inside
  **`code_execution`**, so `server_tool_use` blocks are named `code_execution`,
  not `web_search`. Count `web_search_tool_result` batches instead, and expect
  no query strings on those models.
- **No `citations_delta` for web_search results.** There is no way to know which
  pages informed the answer, which is why the pill says "N results", not
  "sources". Do not relabel it.

## Prompt caching (this is where the money is)

The `web_search` tool definition alone is ~5.8k tokens. Render order is
tools → system → messages, so a `cache_control` breakpoint on the system block
caches the tool definitions too. Measured: 6,254-token prefix, ~$0.031 uncached
vs ~$0.003 cached.

- The prefix is keyed by **model + search on/off**. `effort` is *not* part of it
  (it lives in `output_config`, after the breakpoint).
- TTL 5 minutes, refreshed on every read. Server-side, scoped to the API key —
  shared across tabs and machines.
- With search off the prefix is ~440 tokens, below Opus 5's 512-token minimum,
  so it silently does not cache. That is expected, not a bug.
- **Cold-start stampede:** an entry is only readable once the first response
  starts streaming, so concurrent cold requests each pay a write. A leader gate
  holds the others until the first byte (1 write + 2 reads = $0.046 vs $0.118).

Answers are also cached locally so a reload re-renders instead of re-billing:
1h TTL for search-backed, 24h otherwise. **Regenerate must always force** —
it previously went through the cache and appeared to do nothing.

## Security invariants

- **The API key must never touch the `google.com` origin.** `SECRETS` excludes
  it from the `localStorage` fallback; the shim refuses to store rather than
  downgrading.
- **The settings dialog lives in a closed shadow root.** An `<input>` in the
  page DOM is readable by Google's scripts. `mode: "closed"` also means test
  tooling cannot drive it — verify it visually, not programmatically.
- **Write-only key field.** Never render a stored key back into an input; show a
  masked hint. Validate with `count_tokens` (free) before saving.
- Never put a secret in a URL. `test/_key.js` is gitignored; `.env` is blocked
  by the dev server (403).
- Model output is inserted as **text nodes, never `innerHTML`**.

## Testing

No extension needed. Start the server, then use the fixtures:

```
node dev-server.mjs
# http://localhost:8777/test/userscript.html?q=your+query     (userscript + gm-shim)
# http://localhost:8777/test/fixture.html?q=your+query         (extension content.js + harness)
```

- `test/userscript.html` mirrors the real SERP nesting
  (`#rcnt > #center_col > #gevUs > #search`) and Google's sampled dark-mode
  colours. It is deliberately faithful — a fixture that did *not* use `a h3`
  markup is what caught the page-deleting bug.
- `?buffered=1` makes the shim behave like Tampermonkey on Firefox (no
  incremental `onprogress`). Use it to test the reveal.
- `test/_key.js` supplies the key as `window.__KEY__` (gitignored).
- Real API calls cost money. Prefer `count_tokens` (free) for probes, and reuse
  the local answer cache instead of re-running the same query.

Browser automation: Chrome DevTools MCP for scratch testing. Firefox DevTools
MCP can attach to the user's real browser, but only when Firefox is started with
`--marionette --remote-debugging-port=9222`, and doing so sets
`navigator.webdriver = true`, which every site can read — Google may serve a
bot-variant page. Treat their live browser as read-only unless asked.

## Conventions

- Comments explain **why**, especially where the code looks odd — most odd-
  looking code here is load-bearing and documented above.
- Keep the panel visually inheriting from the SERP: transparent background,
  `color: inherit`, Google's 16px/24px body scale. Claude orange is reserved for
  the identity dot and caret; interactive states use Google's blue.
- Report measurements, not impressions. Nearly every decision here was settled
  by measuring against the live page or API.
