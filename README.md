# Claude Overview

Replaces Google's AI Overview with an answer from Claude, rendered in the same
slot above the results.

## Install

**Userscript (Tampermonkey — the one to use).** Open
`claude-overview.user.js` in Tampermonkey's dashboard (Utilities → Import, or
just open the raw file and let TM offer to install). Then click the ⚙ button in
the panel, or the Tampermonkey menu → *Claude Overview: settings*, and paste an
Anthropic API key. Written against the common GM API, so it also runs on
Violentmonkey and Greasemonkey.

**Extension (Chrome/Firefox MV3)** — the `extension/` folder is the same tool
packaged as an add-on, kept because it can do one thing the userscript cannot
(see below). Chrome: `chrome://extensions` → Developer mode → Load unpacked.
Firefox: `about:debugging` → Load Temporary Add-on → `manifest.json`.

## Userscript vs extension

The userscript is the recommended build. Three things differ:

| | Userscript | Extension |
|---|---|---|
| Suppressing the overview | `location.replace` at `@run-at document-start` | `declarativeNetRequest` redirect |
| API calls | `GM_xmlhttpRequest` (bypasses Google's CSP; plain `fetch` is blocked) | background worker `fetch` |
| Cross-tab cache gate | GM value store + polling lock | shared worker, in-memory |

The redirect is the real difference: the extension rewrites the request before
it is made, while the userscript lets the first navigation start and then
replaces it. That costs one extra navigation on a search that arrives without
`udm=14`, and it is why `@run-at document-start` is mandatory.

## Controls

All in the panel header, so they apply per query without a round trip to
settings:

| Control | Effect |
|---|---|
| **Auto / Manual** | Manual sends nothing until you press Ask Claude, and spends no credits. Google's overview stays suppressed either way. |
| **Model** | Opus 5, Sonnet 5, Haiku 4.5, Fable 5. |
| **Effort** | `low`–`max`. Disabled for Haiku 4.5, which rejects the parameter. |
| **Search** | Gives Claude the web search tool, so answers are grounded rather than from memory. |
| **+** | Adds a comparison column. Each column has its own model/effort/search and runs concurrently. |
| **↻** | Opens the searchable local history. |
| Timer chip | Time left on the Anthropic prompt cache (see below). |

Settings save as soon as you change them — there is no Save button to miss, and
closing the dialog by clicking the backdrop or pressing Escape keeps the change.
The API key is the one exception: it is write-only and keeps an explicit button,
because saving a secret on every keystroke would persist half-typed keys.

The **system prompt** is editable in settings (⚙). It is prefilled with the
default, which is tuned for this slot — short plain prose, no headings, at most
two inline links — so widen it deliberately. Clearing the box restores the
default rather than sending nothing. The sentence telling Claude whether it has
web access is appended automatically from the Search toggle and is not part of
the editable text, so a custom prompt cannot claim searching it cannot do.

When Claude searches, a pill appears under the answer with the site favicons and
a count; clicking it expands a scrolling list. It is labelled "N results", not
"sources", deliberately: the API emits no citations for web_search results, so
there is no way to tell which pages actually informed the answer. Expect
near-miss results in the list (searching "koychi" also returns "Koi Palace") —
the model ignores them, but they are still what the search returned.

Conceptual queries ("why is the sky blue") are answered from knowledge without
searching, so no pill appears — the prompt working as intended, not a failure.

## Answering from the page's own results

Off by default; turn it on in settings (⚙, "Page results"). With it on, each
query also carries extracts of the results Google rendered on that page — every
result as shown, with its source, date, snippet and sitelinks.

The point is not only that Claude can quote them. It is that they are *leads*.
The prompt tells Claude to judge per query: take a fact straight from the block
when it is plainly there (a date, a price, a version number, opening hours, or
several results agreeing), and otherwise treat the entries as starting points —
fetch the page behind the most promising one and read it, or search for it when
no URL is available. A snippet is a fragment Google chose for matching the
query's words, so it routinely shares the query's vocabulary without ever
stating the fact asked for; stitching several of those into an answer none of
them made is the failure mode this is written against.

To make the reading half possible, the `web_fetch` tool is attached whenever
results are attached — and only then, because `web_fetch` can only retrieve URLs
that already appear in the conversation, which is exactly what the results block
puts there. It runs on Anthropic's servers, like `web_search`: nothing is
fetched from your browser, and your IP and cookies are not involved. It is
capped at 3 fetches of at most 6,000 tokens each. A fetched page joins the
source list, and unlike a search hit it is genuine evidence the page was read.

Costs, measured on real SERPs: an 8-result page is about 2.1 KB, roughly 550
input tokens, capped at 12,000 characters. It rides in the user message, after
the cache-control breakpoint, so it never invalidates the ~6.2k-token cached
prefix — but it is fresh input on every query rather than something cached. One
measured answer came to $0.0028 on Sonnet 5. Note also that attaching results
changes the system block, so the on and off variants are separate cached
prefixes.

It frequently removes the need to search at all. On "when is the uk autumn
budget 2026" with web search enabled, Claude ran zero searches and answered from
the page — saving the ~$0.01 search fee, because the answer was already on
screen.

The settings dialog shows the exact text that would be sent for the current
page, in full and scrolling, before you enable anything.

Harvesting is structural rather than class-based, because Google's SERP class
names are obfuscated and rotate. An organic result is an anchor inside `#rso`
containing an `h3` — the same signal the overview-removal climb already relies
on — and the result's own block is that anchor's nearest `[data-hveid]`
ancestor, which holds exactly one `h3` and the whole rendered result. The block's
rendered text is sent as-is rather than parsed into fields, because Google puts
dates in at least two different places (an `Aug 27, 2026 — ` prefix on the
snippet, or inside a `<cite>` meta line such as `4 comments · 5 years ago`), and
normalising that loses more than it gains.

**URLs are the weak point.** Google renders the destination as an abbreviated
`<cite>` (`https://www.example.com › learn › spring-budget-...`), and on some
page variants every result href is an opaque `/goto?url=…` redirect rather than
the destination. A `URL:` line is therefore emitted only when a real address was
recoverable, and the prompt states that only those may be fetched or linked —
the abbreviated display form must never be reconstructed into one. Where no real
URL is recoverable, the fetch half of this feature cannot do anything.

## Where the panel goes

Google does not always rank the overview first. Searching "userscript addon"
puts a direct result (the Tampermonkey store page) above it, and the overview
itself lives *inside* `#search`, not above it — measured on a live SERP:
`#search` starts at y=184, the overview at y=332.

So the panel does not mount at the top of the column. It takes the overview's
own slot: find the overview block, climb to the unit that also owns its "Show
more" control and the ~400px clipped wrapper, insert the panel there, then
delete the unit. Anything Google ranked above keeps its position. Verified live:
8 results before and after, overview gone, panel at y=332 — the exact pixel the
overview occupied.

The climb is guarded against absorbing `#search`, `#rso`, `#center_col`,
`#rcnt` or `#botstuff`. That guard is not theoretical: an earlier version
decided "does this ancestor hold a result" from `a h3` alone, and on markup
where results are not `a h3` it walked past the results container and deleted
the whole page.

Under `udm=14` there is no overview to anchor to, so it falls back to the top of
the results column — which is equivalent, since that mode strips the cards that
would otherwise sit above.

## How Google's overview is actually suppressed

Worth being precise, because the obvious approach does not work:

On current SERPs the AI Overview is **rendered inline in the initial `/search`
document**. Watching the network on a live result page shows no `/async/aion`
request and no separate AI Overview fetch — so there is nothing to intercept,
and request-blocking rules alone accomplish nothing.

What does work is `udm=14`, Google's own web-only results mode. The extension
redirects search navigations to add it, which stops Google generating the
overview server-side. Verified on a live SERP: zero AI Overview markers, versus
one `#m-x-content` block and two `div[data-mcpr]` blocks without it.

The tradeoff is real — `udm=14` also removes knowledge panels and image packs —
so it is a toggle in options. With it off, the extension falls back to removing
the overview from the DOM after render, plus request-blocking rules for the
async path in case Google reverts to it.

**The query still reaches Google.** It has to: it is the search. Nothing here
prevents that, only the overview generation.

## Prompt caching

The `web_search` tool definition is ~5.8k tokens, which would otherwise be
re-billed at full price on every query. The request puts a `cache_control`
breakpoint on the system block; since render order is tools → system → messages,
that caches the tool definitions too.

Measured: 6,254-token prefix, ~$0.031 uncached vs ~$0.003 cached, so ~$0.028
saved per search. With search off the prefix is ~440 tokens, below Opus 5's
512-token minimum, so it simply does not cache (harmless).

The cache lives 5 minutes and every read refreshes it — hence the countdown
chip, so you can see whether the next query will hit it. It is server-side and
keyed on content, scoped to the API key: any tab, window, or machine using the
same key shares it. Nothing accumulates between queries — the query sits after
the cache breakpoint, so uncached input stays ~80 tokens no matter how many
searches you run.

**Cold-start stampede.** A cache entry is only readable once the first response
begins streaming, so simultaneous requests against a cold prefix each pay a
write (measured: three concurrent requests wrote 6,271 tokens apiece and read
nothing). The worker therefore elects a "leader" per cold prefix and holds other
requests until its first byte. Measured with the gate: 1 write + 2 reads,
**$0.046 vs $0.118** for the same burst, at 5.0s wall for all three. Waiting
columns show "waiting for the prompt cache…". A stalled leader releases after
30s so it can never deadlock.

Note that `effort` is *not* part of the cached prefix (it lives in
`output_config`, after the breakpoint), so comparing Opus low against Opus max
shares one prefix — which is exactly the case the gate saves.

The **system prompt is** part of it, though — it is the block the breakpoint
sits on. Editing it in settings therefore starts a new prefix: the first query
after an edit pays the full ~6.2k-token write again, and every query after that
reads the new one. The local answer, thread and warm-cache keys all include a
hash of the prompt text, so a stale answer is never replayed under an edited
prompt and the countdown chip never counts down against a prefix nothing can
read.

## Styling

The panel inherits rather than imposes. Sampled from a live SERP, Google's
result blocks are transparent and borderless with 16px/24px body copy, so the
panel uses `background: transparent`, `color: inherit`, the same type scale, and
a single hairline in Google's own separator colour to mark its extent. Buttons
are outline pills and plain link-blue text actions rather than filled ones. The
Claude orange is reserved for the identity dot and the streaming caret;
interactive states use Google's blue so nothing reads as bolted on.

## The API key

The key is held by the userscript manager (`GM_setValue`) or, in the extension,
`storage.local`. It is sent only to `api.anthropic.com`.

Three things make that safe on a page as hostile as a search results page:

- **Never on the page origin.** The GM shim falls back to `localStorage` when no
  manager storage exists — but `localStorage` on a Google tab is readable by
  Google's own scripts. Secrets are excluded from that fallback: the shim
  refuses to store rather than silently downgrading.
- **The settings dialog lives in a closed shadow root.** An `<input>` appended
  to google.com's DOM can be read by any script on the page. `attachShadow({mode:
  "closed"})` means `host.shadowRoot` is `null` from outside. Verified: with a
  key saved, page script finds **0** inputs anywhere in the document and the key
  appears nowhere in the page HTML.
- **Write-only.** Opening settings never renders the stored key back into a
  field — it shows a masked hint (`sk-ant-api0…IQAA`) instead, and the input is
  cleared immediately after saving. Same in the extension's options page.

Saving validates the key first via `count_tokens`, which is free, so an invalid
key is rejected (401) instead of being stored and failing later on every query.

The most isolated option, if you want it, is Tampermonkey's own dashboard
(script → Storage), which sets the value at the extension origin and never
touches the page at all.

## Reloads and re-billing

Answers persist in the manager's value store, keyed by query + model + effort +
search. A reload, a back/forward, or reopening the same search later re-renders
the stored answer in about a millisecond and makes no API call — the footer says
"cached 12m ago" rather than showing token counts, so a cached result never
silently looks fresh. Changing model, effort or search re-runs; changing back
reuses.

Search-backed answers expire after an hour because they assert current facts;
knowledge answers last a day. **Regenerate** always forces a real call. That
last part was a bug worth naming: Regenerate used to go through the same cache
lookup, so it re-rendered the cached answer and appeared to do nothing.

## Streaming

The answer streams token by token. Which transport delivers it depends on the
manager, and this is the one place they genuinely differ:

- **Chrome-side managers and Violentmonkey** grow `responseText` during
  `onprogress`, so the SSE stream is parsed from a moving offset. Measured in
  the fixture: 119 → 275 → 461 → 606 → 730 characters over 2.2s.
- **Tampermonkey on Firefox does not.** It buffers the whole body and hands it
  over at `onload`, so the answer lands in one lump. Its documented streaming
  path is `responseType: "stream"`, which exposes a `ReadableStream` on
  `onloadstart`.

The script requests `responseType: "stream"` and uses the reader when the
manager provides one, falling back to the `onprogress` offset otherwise.

Neither transport is trusted to look smooth on its own. Incoming text is pushed
into a buffer that drains at a steady rate, so the two cases converge: a manager
that streams keeps the buffer near-empty and the reveal simply tracks it, while
a manager that hands over the whole body at once gets typed out instead of
appearing in a lump. The rate accelerates with backlog (base 340 chars/s,
clearing any backlog in ~0.6s) so a burst never crawls. Measured against a
simulated buffering transport: 755 characters revealed across 42 steps over
1.2s, rather than one jump.

Cached answers are *not* typed out — that would be fake latency on something
already instant. They render at once with a short fade. `prefers-reduced-motion`
disables both the reveal and the fade, and stops the caret blinking.

## History

Every call is logged to `storage.local` (never synced, capped at 1000 entries):
query, answer, model, effort, timing, token usage, searches, and sources. The
history page supports full-text search across queries and answers, filtering by
model/effort/search, JSON export, and clearing.

## Layout

`extension/`  the same tool as an MV3 extension, kept in sync with the
userscript. The userscript is the one that is actually used.

## Known gaps

- **Firefox is untested at runtime.** The code uses a `browser`/`chrome`
  namespace shim and the manifest declares both `background.scripts` (Firefox)
  and `background.service_worker` (Chrome), but I had no way to drive Firefox
  here. The parts most likely to need adjustment are the `declarativeNetRequest`
  redirect rule and `storage.session`.
- Search queries are only recoverable on the basic `web_search_20250305`
  variant (Haiku 4.5, Fable 5). The dynamic-filtering variant used by Opus 5 and
  Sonnet 5 runs its searches from inside `code_execution`, so the panel reports
  the number of result batches and the sources, but not the query strings.
- The AI Overview DOM selectors are best-effort and Google rotates them; the
  text-label sweep is the durable fallback.
- **`web_fetch` is unverified end to end.** Every result href on the SERP
  variant used for testing was a `/goto?url=` redirect, so no fetchable URL was
  ever emitted and the fetch path never ran. That variant is probably a
  bot-page artifact of the automated browser (`navigator.webdriver`), but it has
  not been confirmed against an ordinary session.
- Sending page results is only wired for standard web results. It reads `#rso`,
  so on a page where Google renders no organic results it sends nothing rather
  than failing.
- The result harvester is only exercisable against a live SERP; the offline
  fixtures use simplified result markup with no `#rso`, `a h3` or `data-hveid`.
- Favicons are fetched through `wsrv.nl`, which therefore sees the source
  domains. The browser contacts only that host: wsrv resolves the icon via
  DuckDuckGo's lookup server-side and falls back to the site's own
  `/favicon.ico`. Measured hit rate on a real source list: 5/11 for
  `/favicon.ico` alone, 13/14 for the chain.
