const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { Script, createContext } = require("node:vm");
const { test } = require("node:test");

const script = new Script(readFileSync(new URL("./app.js", "file://" + __filename), "utf8"),
  { filename: "web/app.js" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(fetcher) {
  const elements = new Map();
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.textContent = "";
      this.className = "";
      this.style = {};
      this.hidden = false;
      this.children = [];
      this.listeners = {};
    }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(name, value) { this[name] = value; }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element("div"));
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  class FakeEventSource {
    static CLOSED = 2;
    static instances = [];
    constructor(path) {
      assert.equal(path, "/events");
      this.listeners = {};
      this.readyState = 1;
      FakeEventSource.instances.push(this);
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    emit(event) {
      const message = { type: event.type, data: JSON.stringify(event),
        lastEventId: String(event.id) };
      if (this.listeners[event.type]) this.listeners[event.type](message);
      else if (this.onmessage) this.onmessage(message);
    }
    close() { this.readyState = 2; }
  }
  const window = { location: { search: "" }, EventSource: FakeEventSource };
  script.runInContext(createContext({
    document, window, EventSource: FakeEventSource, fetch: fetcher,
    AbortController, setTimeout, clearTimeout, URL, URLSearchParams, console,
  }));
  return {
    element: (id) => document.getElementById(id),
    stream: FakeEventSource.instances[0],
  };
}
function flatten(node) {
  return [String(node.textContent), ...node.children.flatMap(flatten)].join(" ");
}
function stats(blocked) {
  return { off: { spent: "60000", wasted: "60000", injections: 0 },
    on: { spent: "0", wasted: "0", blocked } };
}
const merchants = [{
  id: "judge-only", name: "Judge Observation", score: 6/7,
  verdict: "ok", flags: ["PROMPT_INJECTION"], evidence: [{
    flag: "PROMPT_INJECTION", by: "judge", quoted: "10000", charged: "10000",
    txHash: "0xmockface", explorerUrl: null, detail: "Advisory content only", ts: 1,
  }],
}];
function json(value) { return { ok: true, json: async () => value }; }

test("B2: contract string flags use judge evidence attribution, and mock tx has no link", async () => {
  const app = mount(async (path) =>
    path === "/merchants" ? json(merchants) : json(stats(1)));
  await sleep(20);
  const table = flatten(app.element("merchant-rows"));
  assert.match(table, /PROMPT_INJECTION · AI judge/);
  assert.match(table, /AI judge observation · advisory only/);
  assert.match(table, /SIMULATED · NO CHAIN TX/);
  assert.equal(app.element("blocked-count").textContent, "1");
  app.stream.close();
});

test("B2: continuous SSE events do not abort in-flight API refreshes", async () => {
  let statReads = 0;
  let aborts = 0;
  const app = mount(async (path, options) => {
    if (statReads === 0) {
      if (path === "/stats") statReads++;
      return json(path === "/merchants" ? [] : stats(1));
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        aborts++;
        reject(new Error("aborted"));
      }, { once: true });
    });
    if (path === "/stats") statReads++;
    return json(path === "/merchants" ? [] : stats(2));
  });
  await sleep(25);
  for (let i = 0; i < 3; i++) {
    app.stream.emit({ id: i + 10, type: "guard_blocked",
      actor: "guard", payload: { merchantId: "ghost" } });
    if (i < 2) await sleep(300);
  }
  await sleep(260);
  assert.equal(app.element("blocked-count").textContent, "2",
    "Merchant/Stats must update while the event stream is still active");
  assert.equal(aborts, 0, "SSE must not abort in-flight refresh requests");
  app.stream.emit({ id: 99, type: "reset", actor: "feed", payload: {} });
  assert.equal(app.element("blocked-count").textContent, "—");
  assert.doesNotMatch(flatten(app.element("event-list")), /ID \/ ghost/);
  app.stream.close();
});
