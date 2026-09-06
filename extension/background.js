"use strict";

// Firefox exposes the promise-based `browser` namespace; Chrome exposes `chrome`.
// Both support the subset used here, so bind whichever exists.
const api = globalThis.browser || globalThis.chrome;


const API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Per-model request-shape rules. These are not cosmetic: `output_config.effort`
// is rejected on Haiku 4.5, Fable 5 rejects any explicit `thinking` config, and
// the dynamic-filtering web_search_20260209 variant is limited to the newer
// models — everything else must use the basic variant.
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

const SYSTEM = [
  "You are answering a web search query inline, in the slot where Google would",
  "otherwise show its AI Overview. The reader wants the answer, not an essay.",
  "",
  "Lead with the direct answer in the first sentence. Follow with at most two or",
  "three short sentences of the context that actually changes what the reader",
  "would do or think next. Keep sentences short. Stay under 90 words.",
  "",
  "Write plain prose. No headings, no bullet lists, no emoji, no preamble, no",
  "sign-off, no restating the question, and no closing follow-up question. You",
  "may use **bold** for a key term and `code` for literal syntax.",
  "Use simple language that reads clearly for a non-native speaker.",
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

const NO_SEARCH_NOTE = [
  "",
  "You have no web access for this answer, so answer from memory. If the query",
  "turns on facts that change over time — prices, standings, who currently holds",
  "a role, latest versions — say so plainly in a short clause instead of",
  "guessing at a current value.",
].join("\n");

const SEARCH_NOTE = [
  "",
  "You can search the web. Search when the answer depends on current or",
  "verifiable facts, and answer directly from knowledge when it does not — a",
  "definitional or conceptual query rarely needs a search. Keep searches few and",
  "targeted. Do not narrate your searching or list sources; just answer.",
].join("\n");

/* Sent as a SECOND system block on follow-up turns only. It must never be
   merged into the block above: that one carries the cache_control breakpoint,
   and editing it would fork the ~6.2k-token prefix into a second entry keyed
   by whether the turn is a follow-up. Blocks placed after the breakpoint still
   match the cached prefix, so this costs a few tokens and nothing else.

   The base prompt is written for a one-shot overview - 90 words, no follow-up
   question, no preamble. Most of that is wrong once the reader is actually
   talking to you, so this relaxes exactly the parts that conflict. */
const FOLLOWUP_NOTE = [
  "The reader has followed up on the answer above, so this is now a",
  "conversation rather than a search overview. Answer the follow-up directly,",
  "in plain prose, and assume everything already said is shared context - do",
  "not restate it. You may run to about 150 words when the question genuinely",
  "needs it, and you may end by naming a specific open question if one",
  "actually matters. Still no headings, no bullet lists, no preamble and no",
  "sign-off.",
].join("\n");

/* Appended mechanically from the results toggle, exactly like SEARCH_NOTE, so
   it can never claim page content that was not actually attached.

   The URL warning is load-bearing. Google renders the destination as an
   abbreviated <cite> ("https://www.tembomoney.com > learn > spring-budget-..."),
   and on some page variants the anchor href is an opaque /goto?url= redirect
   rather than the destination - so a "URL" in this block is frequently not a
   URL you can navigate to. The base prompt promises never to guess a link;
   without this the results block would become the thing that breaks it. */
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

// Cheap, stable key material - not a security hash.
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function getKey() {
  const { apiKey } = await api.storage.local.get("apiKey");
  return apiKey || "";
}

// ctxSig is a coarse signature of the page context (day + zone + place), not
// the context itself: a location- or date-dependent answer must not be
// replayed for a different day or place, but the clock must not be part of the
// key or nothing would ever hit.
// resSig is the same idea for the page's own search results: the answer is
// built from what Google rendered, so a different result set must not replay
// an answer produced from the previous one.
function cacheKey(q, model, effort, search, ctxSig, resSig) {
  return (
    "a:" + model + ":" + effort + ":" + (search ? "s" : "n") +
    ":" + (ctxSig || "-") + ":" + (resSig || "-") + ":" + q
  );
}

// A follow-up is keyed by the whole exchange leading up to it, not by the
// original query: two different conversations can reach the same question and
// must not share an answer.
function followUpKey(model, effort, search, prior, sentUser) {
  return (
    "a:" + model + ":" + effort + ":" + (search ? "s" : "n") + ":f:" +
    hashStr(JSON.stringify(prior) + sentUser)
  );
}

/* Local spend accounting. The Usage & Cost Admin API needs an Admin API key
   and is unavailable for individual accounts, so there is nothing to query -
   but every response already reports exactly what was billed, so the cost is
   computable here with no extra request and no second credential.

   USD per million tokens, from the pricing page (2026-08-22). Cache writes are
   1.25x input at the 5-minute TTL, cache reads 0.1x. Prices change: this is an
   estimate for orientation, not an invoice. */
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

// Prompt-cache TTL; reads refresh it.
const CACHE_TTL_MS = 5 * 60 * 1000;

// The cached prefix IS the tool definitions plus the system block, so anything
// that changes the system block forks it. RESULTS_NOTE is appended from the
// results toggle, so that flag belongs in the key too - without it the warm
// chip would count down against a prefix nothing is going to read, and the
// leader gate would hold requests for a write that already happened under the
// other variant.
function prefixKey(model, search, results) {
  return "cw:" + model + ":" + (search ? "s" : "n") + (results ? ":r" : "");
}

// A prompt-cache entry only becomes readable once the first response has begun
// streaming, so requests fired simultaneously against a cold prefix each pay a
// cache write. Measured: three concurrent cold requests wrote 6,271 tokens
// apiece and read nothing. The first request through a cold prefix therefore
// becomes its "leader"; anything else wanting that same prefix waits for the
// leader's first byte, then reads the entry the leader just wrote.
//
// This lives in the worker rather than the panel so it covers both comparison
// columns and separate tabs opened at once — every content script shares it.
const prefixLeaders = new Map();
const LEADER_TIMEOUT_MS = 30000;

async function acquirePrefix(pk) {
  const stored = await api.storage.session.get(pk);
  const warm = stored[pk];
  if (warm && warm.expires > Date.now()) return null; // already warm: go now

  const leader = prefixLeaders.get(pk);
  if (leader) {
    // Someone is already warming this prefix. Wait, but never indefinitely —
    // a stalled leader must not deadlock every other query.
    await Promise.race([
      leader.promise,
      new Promise((r) => setTimeout(r, LEADER_TIMEOUT_MS)),
    ]);
    return null;
  }

  let release;
  const promise = new Promise((r) => (release = r));
  const handle = {
    release() {
      if (prefixLeaders.get(pk) === handle) prefixLeaders.delete(pk);
      release();
    },
  };
  handle.promise = promise;
  prefixLeaders.set(pk, handle);
  return handle;
}

const HISTORY_CAP = 1000;

// Local-only history log, capped.
async function recordHistory(entry) {
  const { history = [] } = await api.storage.local.get("history");
  history.unshift(entry);
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
  await api.storage.local.set({ history });
}

// udm=14 is the only mechanism that actually stops Google generating the AI
// Overview server-side — on current SERPs it ships inline in the search
// document, so there is no async request to block. It also drops knowledge
// panels and image packs, hence the toggle.
async function syncUdmRuleset() {
  const { udm14 = true } = await api.storage.sync.get({ udm14: true });
  try {
    await api.declarativeNetRequest.updateEnabledRulesets(
      udm14
        ? { enableRulesetIds: ["udm14"] }
        : { disableRulesetIds: ["udm14"] }
    );
  } catch (e) {
    /* ruleset already in the requested state */
  }
}

api.runtime.onInstalled.addListener(syncUdmRuleset);
api.runtime.onStartup.addListener(syncUdmRuleset);
api.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.udm14) syncUdmRuleset();
});

/* Conversations are held here rather than in page storage: a thread is the
   user's, and the google.com origin is readable by Google's own scripts.
   Session storage, so they last as long as the browser is open and no longer -
   the same lifetime as the answer cache they sit alongside. */
const THREAD_CAP = 40;

async function threadPut(key, turns) {
  const all = await api.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("t:"));
  // Evict oldest first so a long session cannot grow the store without bound.
  if (keys.length >= THREAD_CAP) {
    keys.sort((x, y) => (all[x].ts || 0) - (all[y].ts || 0));
    await api.storage.session.remove(keys.slice(0, keys.length - THREAD_CAP + 1));
  }
  await api.storage.session.set({ ["t:" + key]: { turns, ts: Date.now() } });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "open-options") api.runtime.openOptionsPage();
  if (msg.type === "open-history") {
    api.tabs.create({ url: api.runtime.getURL("history.html") });
  }
  if (msg.type === "thread-get") {
    // Returning true keeps the message channel open for the async reply; the
    // panel awaits this before deciding whether to replay stored turns.
    api.storage.session
      .get("t:" + msg.key)
      .then((all) => sendResponse(all["t:" + msg.key] || null))
      .catch(() => sendResponse(null));
    return true;
  }
  if (msg.type === "thread-put") {
    threadPut(msg.key, msg.turns);
  }
  if (msg.type === "thread-drop") {
    api.storage.session.remove("t:" + msg.key);
  }
});

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude-overview") return;

  let aborter = null;
  port.onDisconnect.addListener(() => {
    if (aborter) aborter.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "ask") return;

    const { query, model, effort, search } = msg;
    // Both are built in the content script (this worker has no page or DOM)
    // and sent per request. They go in the USER MESSAGE, after the
    // cache_control breakpoint, so they never invalidate the ~6.2k-token
    // cached prefix - which is the whole reason they are not in the system
    // block despite reading like instructions.
    const ctx = msg.context && msg.context.text ? msg.context : null;
    const pageRes = msg.results && msg.results.text ? msg.results : null;

    // prior holds the turns already exchanged, exactly as they were sent, so a
    // follow-up replays byte-identical text and the cached prefix still hits.
    const prior = Array.isArray(msg.prior) ? msg.prior : [];
    const isFollowUp = prior.length > 0;
    // The page blocks ride on the first user turn only; later turns inherit
    // them through the thread rather than repeating them every message.
    const sentUser = isFollowUp
      ? msg.question
      : [ctx && ctx.text, pageRes && pageRes.text, query]
          .filter(Boolean)
          .join("\n\n");

    const post = (m) => {
      try {
        port.postMessage(m);
      } catch (e) {
        /* port closed mid-stream; nothing to do */
      }
    };

    // Serve a cached answer rather than re-spending credits on a repeat view
    // (back/forward navigation re-runs the content script).
    const ck = isFollowUp
      ? followUpKey(model, effort, search, prior, sentUser)
      : cacheKey(query, model, effort, search, ctx && ctx.sig, pageRes && pageRes.sig);
    const cached = await api.storage.session.get(ck);
    if (cached[ck]) {
      post({ type: "delta", text: cached[ck].text });
      post({
        type: "done", model, cached: true,
        usage: cached[ck].usage,
        queries: cached[ck].queries || [],
        sources: cached[ck].sources || [],
        // The panel seeds its thread from sentUser, so a cached answer has to
        // carry it too or a follow-up after a reload starts from nothing.
        sentUser,
      });
      return;
    }
    const startedAt = Date.now();

    const key = await getKey();
    if (!key) {
      post({
        type: "error",
        needsKey: true,
        message: "No Anthropic API key set. Add one to start answering queries.",
      });
      return;
    }

    // Wait behind a cold-prefix leader if one is already warming this exact
    // tools+system prefix, so we read its entry instead of writing a duplicate.
    const pk = prefixKey(model, search, !!pageRes);
    let gate = null;
    if (search) {
      const pending = prefixLeaders.get(pk);
      if (pending) post({ type: "queued" });
      gate = await acquirePrefix(pk);
    }

    const rules = MODEL_RULES[model] || MODEL_RULES["claude-opus-5"];
    const body = {
      model,
      max_tokens: search ? 4096 : 1024,
      stream: true,
      // tools -> system -> messages, so this breakpoint caches the tool defs
      // too (~5.8k tokens with search on). Inert below the cache minimum.
      system: [
        {
          type: "text",
          text:
            SYSTEM +
            (search ? SEARCH_NOTE : NO_SEARCH_NOTE) +
            (pageRes ? RESULTS_NOTE : ""),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: prior
        .map((t) => ({ role: t.role, content: t.text }))
        .concat([
          {
            role: "user",
            content: isFollowUp
              ? // Second breakpoint: caches everything up to and including this
                // turn, so the NEXT follow-up reads the whole conversation
                // instead of re-paying for it. Two breakpoints total, well
                // inside the limit of four.
                [{ type: "text", text: sentUser, cache_control: { type: "ephemeral" } }]
              : sentUser,
          },
        ]),
    };
    // Relaxes the one-shot rules the base prompt imposes. Appended after the
    // cached block, so the prefix still matches and nothing is re-written.
    if (isFollowUp) body.system.push({ type: "text", text: FOLLOWUP_NOTE });
    body.tools = [];
    if (search) {
      body.tools.push({ type: rules.search, name: "web_search", max_uses: 4 });
    }
    /* web_fetch can only retrieve URLs already present in the conversation, so
       it is useless without the results block and exactly right with it: the
       results are leads, and this turns a lead into the page itself. Bounded
       deliberately - each fetched page is fresh input on top of the prefix, so
       max_uses and max_content_tokens are what keep an answer from costing
       several cents. */
    if (pageRes && rules.fetch) {
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

    aborter = new AbortController();
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        signal: aborter.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          // Required for calls originating from a browser context.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (gate) gate.release();
      post({ type: "error", message: "Network error: " + e.message });
      return;
    }

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || "";
      } catch (e) {
        /* non-JSON error body */
      }
      if (gate) gate.release();
      post({
        type: "error",
        needsKey: res.status === 401,
        message:
          "API error " + res.status + (detail ? ": " + detail : ""),
      });
      return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let acc = "";
    let usage = {};
    let stopReason = null;
    let searchCount = 0;
    let fetchCount = 0;
    const queries = [];
    const sources = [];
    const seenUrls = new Set();
    // server_tool_use inputs stream as partial JSON, so accumulate per block
    // and parse on content_block_stop to recover the query the model ran.
    let toolBlock = null;
    let toolJson = "";

    const addSource = (url, title) => {
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      sources.push({ url, title: title || url });
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a frame can span reads.
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
            // The entry is readable once the response starts, so unblock
            // waiters at the first event rather than at the end.
            if (gate) {
              gate.release();
              gate = null;
            }
            if (
              ev.type === "content_block_delta" &&
              ev.delta &&
              ev.delta.type === "text_delta"
            ) {
              acc += ev.delta.text;
              post({ type: "delta", text: ev.delta.text });
            } else if (ev.type === "content_block_start" && ev.content_block) {
              const cb = ev.content_block;
              // Only the basic web_search variant exposes the query as a
              // server_tool_use input. The dynamic-filtering variant runs its
              // searches from inside code_execution, so there is no query to
              // read there — hence counting result batches, not tool uses.
              if (cb.type === "server_tool_use" && cb.name === "web_search") {
                toolBlock = ev.index;
                toolJson = "";
              } else if (cb.type === "web_search_tool_result") {
                searchCount++;
                const items = Array.isArray(cb.content) ? cb.content : [];
                for (const r of items) addSource(r.url, r.title);
                post({ type: "searching", n: searchCount });
                if (sources.length) post({ type: "sources", sources });
              } else if (cb.type === "web_fetch_tool_result") {
                /* A fetch is stronger evidence than a search hit: the page was
                   actually retrieved and read. Errors arrive here too, as a
                   single object rather than a list - the API returns HTTP 200
                   with an error_code and never throws. */
                const c = cb.content;
                if (c && !c.error_code) {
                  fetchCount++;
                  addSource(c.url, (c.document && c.document.title) || c.url);
                  post({ type: "fetching", n: fetchCount });
                  if (sources.length) post({ type: "sources", sources });
                }
              }
            } else if (
              ev.type === "content_block_delta" &&
              ev.delta &&
              ev.delta.type === "input_json_delta" &&
              ev.index === toolBlock
            ) {
              toolJson += ev.delta.partial_json || "";
            } else if (
              ev.type === "content_block_delta" &&
              ev.delta &&
              ev.delta.type === "citations_delta" &&
              ev.delta.citation
            ) {
              addSource(ev.delta.citation.url, ev.delta.citation.title);
            } else if (ev.type === "content_block_stop" && ev.index === toolBlock) {
              try {
                const q = JSON.parse(toolJson).query;
                if (q) {
                  queries.push(q);
                  post({ type: "searching", n: searchCount, query: q });
                }
              } catch (e) {
                /* partial or non-search tool input */
              }
              toolBlock = null;
            } else if (ev.type === "message_start" && ev.message) {
              usage = Object.assign({}, usage, ev.message.usage);
            } else if (ev.type === "message_delta") {
              usage = Object.assign({}, usage, ev.usage);
              if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
            } else if (ev.type === "error") {
              post({
                type: "error",
                message: (ev.error && ev.error.message) || "Stream error",
              });
              return;
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        post({ type: "error", message: "Stream failed: " + e.message });
      }
      return;
    } finally {
      // Covers aborts and stream errors: never strand other queries behind a
      // leader that will not finish.
      if (gate) gate.release();
    }

    // Safety classifiers can decline a request: HTTP 200, no text, stop_reason
    // "refusal". Without this branch the panel would just sit empty.
    if (stopReason === "refusal") {
      const m = "Claude declined to answer this query.";
      await recordHistory({
        ts: startedAt, query, model, effort, search, error: m,
      });
      post({ type: "error", message: m });
      return;
    }
    if (!acc.trim()) {
      const m = "Empty response from the API.";
      await recordHistory({
        ts: startedAt, query, model, effort, search, error: m,
      });
      post({ type: "error", message: m });
      return;
    }

    await api.storage.session.set({ [ck]: { text: acc, usage, queries, sources } });

    // Prefix is tools+system, so key by model + whether search was attached.
    if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
      await api.storage.session.set({
        [pk]: {
          model,
          search: !!search,
          expires: Date.now() + CACHE_TTL_MS,
          tokens:
            usage.cache_read_input_tokens ||
            usage.cache_creation_input_tokens ||
            0,
        },
      });
    }
    await recordHistory({
      ts: startedAt,
      ms: Date.now() - startedAt,
      // The follow-up text is the searchable query for this entry; the thread
      // id keeps the turns of one conversation findable together.
      query: isFollowUp ? msg.question : query,
      followUp: isFollowUp || undefined,
      thread: msg.threadId || undefined,
      turn: isFollowUp ? prior.length / 2 + 1 : 1,
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
      stopReason,
    });
    post({ type: "done", model, usage, queries, sources, sentUser, cost: costOf(model, usage) });
  });
});
