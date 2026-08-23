// Test harness: stubs the chrome.* extension APIs that content.js depends on,
// and implements the background worker's streaming call inline so the panel is
// exercised against the real Anthropic API.
/* Same numbers as background.js and the userscript; the fixture should report
   the same cost the real build would. USD per million tokens, 2026-08-22. */
const PRICES = {
  "claude-opus-5": { in: 5, out: 25, write: 6.25, read: 0.5 },
  "claude-sonnet-5": { in: 2, out: 10, write: 2.5, read: 0.2 },
  "claude-haiku-4-5": { in: 1, out: 5, write: 1.25, read: 0.1 },
  "claude-fable-5": { in: 10, out: 50, write: 12.5, read: 1 },
};
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
    (st.web_search_requests || 0) * 0.01
  );
}

(() => {
  const store = { sync: {}, session: {} };
  const params = new URLSearchParams(location.search);
  const KEY = params.get("key") || window.__KEY__ || "";

  // Mirrors the worker's cold-prefix gate.
  const leaders = new Map();
  async function acquirePrefix(pk) {
    const w = store.session[pk];
    if (w && w.expires > Date.now()) return null;
    const lead = leaders.get(pk);
    if (lead) {
      await Promise.race([lead.promise, new Promise((r) => setTimeout(r, 30000))]);
      return null;
    }
    let release;
    const promise = new Promise((r) => (release = r));
    const h = { promise, release() { if (leaders.get(pk) === h) leaders.delete(pk); release(); } };
    leaders.set(pk, h);
    return h;
  }

  window.chrome = {
    storage: {
      sync: {
        get: async (d) => Object.assign({}, d, store.sync),
        set: async (o) => void Object.assign(store.sync, o),
      },
      local: { get: async () => ({}), set: async () => {} },
      session: {
        get: async (k) =>
          k === null
            ? { ...store.session }
            : store.session[k]
            ? { [k]: store.session[k] }
            : {},
        set: async (o) => void Object.assign(store.session, o),
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL: (p) => p,
      // The panel stores conversations through the worker, so the fixture has
      // to answer those messages or follow-ups never replay after a reload.
      sendMessage: (m) => {
        if (m && m.type === "thread-put") {
          store.session["t:" + m.key] = { turns: m.turns, ts: Date.now() };
          return Promise.resolve();
        }
        if (m && m.type === "thread-get") {
          return Promise.resolve(store.session["t:" + m.key] || null);
        }
        if (m && m.type === "thread-drop") {
          delete store.session["t:" + m.key];
          return Promise.resolve();
        }
        console.log("[sendMessage]", m);
        return Promise.resolve();
      },
      connect() {
        const listeners = [];
        let dead = false;
        const emit = (m) => !dead && listeners.forEach((f) => f(m));
        return {
          onMessage: { addListener: (f) => listeners.push(f) },
          disconnect() { dead = true; },
          async postMessage(msg) {
            if (msg.type !== "ask") return;
            const body = {
              model: msg.model,
              max_tokens: msg.search ? 4096 : 1024,
              stream: true,
              system: [{
                type: "text",
                text: window.__SYSTEM__ || "Answer the search query in under 60 words. Plain prose, answer first, no preamble, no headings, no lists.",
                cache_control: { type: "ephemeral" },
              }],
              messages: (Array.isArray(msg.prior) ? msg.prior : [])
                .map((t) => ({ role: t.role, content: t.text }))
                .concat([
                  {
                    role: "user",
                    content:
                      Array.isArray(msg.prior) && msg.prior.length
                        ? [
                            {
                              type: "text",
                              text: msg.question,
                              cache_control: { type: "ephemeral" },
                            },
                          ]
                        : msg.context && msg.context.text
                        ? msg.context.text + "\n\n" + msg.query
                        : msg.query,
                  },
                ]),
            };
            if (msg.model !== "claude-haiku-4-5") {
              body.output_config = { effort: msg.effort };
              body.thinking = { type: "adaptive" };
            }
            if (msg.search) {
              body.tools = [{
                type: msg.model === "claude-haiku-4-5"
                  ? "web_search_20250305" : "web_search_20260209",
                name: "web_search", max_uses: 4,
              }];
            }
            const pk = "cw:" + msg.model + ":" + (msg.search ? "s" : "n");
            let gate = null;
            if (msg.search) {
              if (leaders.get(pk)) emit({ type: "queued" });
              gate = await acquirePrefix(pk);
            }
            let res;
            try {
              res = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-api-key": KEY,
                  "anthropic-version": "2023-06-01",
                  "anthropic-dangerous-direct-browser-access": "true",
                },
                body: JSON.stringify(body),
              });
            } catch (e) {
              return emit({ type: "error", message: "Network: " + e.message });
            }
            if (!res.ok) {
              return emit({
                type: "error",
                message: "API " + res.status + " " + (await res.text()).slice(0, 300),
              });
            }
            const rd = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "", usage = {}, n = 0;
            const queries = [], sources = [], seen = new Set();
            let toolBlock = null, toolJson = "";
            const addSource = (url, title) => {
              if (!url || seen.has(url)) return;
              seen.add(url);
              sources.push({ url, title: title || url });
            };
            for (;;) {
              const { done, value } = await rd.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, i);
                buf = buf.slice(i + 2);
                for (const line of frame.split("\n")) {
                  if (!line.startsWith("data:")) continue;
                  let ev;
                  try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
                  if (gate) { gate.release(); gate = null; }
                  if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
                    emit({ type: "delta", text: ev.delta.text });
                  } else if (ev.type === "content_block_start" && ev.content_block) {
                    const cb = ev.content_block;
                    if (cb.type === "server_tool_use" && cb.name === "web_search") {
                      toolBlock = ev.index; toolJson = "";
                    } else if (cb.type === "web_search_tool_result") {
                      n++;
                      for (const r of (Array.isArray(cb.content) ? cb.content : [])) {
                        addSource(r.url, r.title);
                      }
                      emit({ type: "searching", n });
                      if (sources.length) emit({ type: "sources", sources });
                    }
                  } else if (ev.type === "content_block_delta" &&
                             ev.delta && ev.delta.type === "input_json_delta" &&
                             ev.index === toolBlock) {
                    toolJson += ev.delta.partial_json || "";
                  } else if (ev.type === "content_block_stop" && ev.index === toolBlock) {
                    try {
                      const q = JSON.parse(toolJson).query;
                      if (q) { queries.push(q); emit({ type: "searching", n, query: q }); }
                    } catch (e) {}
                    toolBlock = null;
                  } else if (ev.type === "message_start") {
                    usage = Object.assign(usage, ev.message.usage);
                  } else if (ev.type === "message_delta") {
                    usage = Object.assign(usage, ev.usage);
                  }
                }
              }
            }
            if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
              store.session["cw:" + msg.model + ":" + (msg.search ? "s" : "n")] = {
                model: msg.model, search: !!msg.search,
                expires: Date.now() + 5 * 60 * 1000,
                tokens: usage.cache_read_input_tokens || usage.cache_creation_input_tokens,
              };
            }
            if (gate) gate.release();
            // Mirrors background.js: the panel needs sentUser to seed a thread,
            // and cost to show spend.
            const sentUser =
              Array.isArray(msg.prior) && msg.prior.length
                ? msg.question
                : msg.context && msg.context.text
                ? msg.context.text + "\n\n" + msg.query
                : msg.query;
            emit({
              type: "done",
              model: msg.model,
              usage,
              queries,
              sources,
              sentUser,
              cost: costOf(msg.model, usage),
            });
          },
        };
      },
    },
  };
})();
