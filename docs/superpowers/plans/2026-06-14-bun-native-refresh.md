# Bun-Native Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Bun-native cached-first refresh path that renders persisted metrics immediately, streams fresh-scan progress over SSE, and improves cold fresh-scan performance with benchmarks.

**Architecture:** Move event loading out of individual request handlers and into a `SnapshotManager` that owns persisted snapshots, refresh progress, and deduped fresh scans. Compute all dashboard aggregates once per event snapshot, serve existing endpoint shapes from those aggregates, and replace Express with `Bun.serve` plus small local routing/static helpers.

**Tech Stack:** Bun runtime, `Bun.serve`, Web `Response`/`Request`, SSE via `ReadableStream`, existing CommonJS adapters, Bun/Node test runner as needed during migration.

---

## File Structure

- Create `aggregates.js`: pure aggregate builder for history, projects, tool calls, daily costs, and metrics.
- Create `snapshot-manager.js`: cache loading, persisted snapshot writing, refresh dedupe, progress state, and SSE event publishing.
- Create `sse.js`: minimal subscriber hub and SSE response formatting.
- Create `bun-server.js`: Bun-native HTTP router and static file serving.
- Modify `server.js`: thin Bun entry point that starts `bun-server.js`, preserving `bin` compatibility.
- Modify `index.html`: cached/fresh status badge, progress UI, `/api/bootstrap` loading, SSE connection, and endpoint fallback during migration.
- Modify `package.json`: prefer Bun for tests/benchmarks when runtime-specific behavior is covered.
- Create or modify tests: `aggregates.test.js`, `snapshot-manager.test.js`, `sse.test.js`, and server/API tests where practical.
- Modify benchmark scripts: add bootstrap, refresh, per-agent timing, and cached-first timing.

## Task 1: Record Baseline Benchmarks

**Files:**
- Modify: `scripts/benchmark-cold-api.js`
- Modify: `scripts/benchmark-api.js`

- [ ] **Step 1: Add baseline endpoint coverage**

Update `scripts/benchmark-cold-api.js` so it can benchmark `/api/agents`, `/api/history`, `/api/daily-costs`, and `/api/metrics` in one cold server run:

```js
const endpoints = (process.env.AGENT_LENS_COLD_ENDPOINTS || "/api/agents,/api/history,/api/daily-costs,/api/metrics")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
```

Inside `runRound`, loop over `endpoints`, fetch each URL, and return `{ endpoint, ms }` samples. Keep the existing single-endpoint environment variable working by mapping `AGENT_LENS_COLD_ENDPOINT` into `AGENT_LENS_COLD_ENDPOINTS` when present.

- [ ] **Step 2: Run baseline cold benchmark**

Run:

```bash
npm run benchmark:cold
```

Expected: prints per-round timings for each endpoint and a summary. Save the output in the final implementation notes.

- [ ] **Step 3: Run warm API benchmark**

Start the current server:

```bash
AGENT_LENS_PORT=4567 npm start
```

Then in another command:

```bash
npm run benchmark
```

Expected: prints timings for `/api/history`, `/api/projects`, `/api/tool-calls`, `/api/daily-costs`, and `/api/metrics` for all agents and selected filters.

- [ ] **Step 4: Commit benchmark script changes**

```bash
git add scripts/benchmark-cold-api.js scripts/benchmark-api.js
git commit -m "Benchmark dashboard startup endpoints"
```

## Task 2: Extract Shared Aggregate Builder

**Files:**
- Create: `aggregates.js`
- Create: `aggregates.test.js`
- Modify: `server.js`

- [ ] **Step 1: Write failing aggregate test**

Create `aggregates.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAggregates } = require("./aggregates");

test("builds dashboard aggregates once from an event snapshot", () => {
  const events = [
    { agent: "codex", timestamp: "2026-06-14T10:00:00.000Z", sessionId: "s1", project: "/repo/a", type: "user", prompt: "hello" },
    { agent: "codex", timestamp: "2026-06-14T10:00:01.000Z", sessionId: "s1", project: "/repo/a", type: "assistant", model: "gpt-test", tokens: { input: 100, output: 20, cacheRead: 10, cacheCreate: 0 } },
    { agent: "codex", timestamp: "2026-06-14T10:00:02.000Z", sessionId: "s1", project: "/repo/a", type: "tool", toolCall: { name: "Read", input: { file_path: "README.md" } } },
    { agent: "gemini", timestamp: "2026-06-13T08:00:00.000Z", sessionId: "s2", project: "/repo/b", type: "user", prompt: "inspect" },
  ];

  const aggregates = buildAggregates(events, { agent: null });

  assert.equal(aggregates.history.length, 2);
  assert.equal(aggregates.projects[0].name, "/repo/a");
  assert.equal(aggregates.toolCalls.tools[0].tool, "Read");
  assert.equal(aggregates.dailyCosts.totals.messages, 2);
  assert.equal(aggregates.metrics.agents.find((agent) => agent.name === "codex").messages, 1);
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --test aggregates.test.js
```

Expected: fails because `./aggregates` does not exist.

- [ ] **Step 3: Implement `buildAggregates`**

Create `aggregates.js` with:

```js
const { PER_AGENT, costFor } = require("./rates");

function dayOf(ts) {
  return (ts || "").slice(0, 10);
}

function buildAggregates(events, { agent = null } = {}) {
  const filtered = agent ? events.filter((event) => event.agent === agent) : events;
  return {
    history: buildHistory(filtered),
    projects: buildProjects(filtered),
    toolCalls: buildToolCalls(filtered),
    dailyCosts: buildDailyCosts(filtered, agent),
    metrics: buildMetrics(filtered, agent),
  };
}

module.exports = { buildAggregates };
```

Move the existing aggregation logic from `server.js` into helper functions in this file without changing endpoint response shapes.

- [ ] **Step 4: Route existing endpoints through aggregates**

Modify `server.js` so `/api/history`, `/api/projects`, `/api/tool-calls`, `/api/daily-costs`, and `/api/metrics` call `buildAggregates(events, { agent })` and return the matching property.

- [ ] **Step 5: Verify green**

Run:

```bash
node --test aggregates.test.js
npm test
```

Expected: aggregate test passes and existing suite remains green.

- [ ] **Step 6: Commit aggregate extraction**

```bash
git add aggregates.js aggregates.test.js server.js
git commit -m "Share dashboard aggregate computation"
```

## Task 3: Add Snapshot Manager and Progress State

**Files:**
- Create: `snapshot-manager.js`
- Create: `snapshot-manager.test.js`
- Modify: `event-cache.js` only if reusable pieces are needed

- [ ] **Step 1: Write failing cached-first test**

Create `snapshot-manager.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSnapshotManager } = require("./snapshot-manager");

test("returns persisted snapshot immediately while starting a refresh", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({
    generatedAt: "2026-06-14T10:00:00.000Z",
    events: [{ agent: "codex", type: "user", timestamp: "2026-06-14T10:00:00.000Z", sessionId: "s1", project: "/repo", prompt: "cached" }],
  }));

  let resolveLoad;
  const manager = createSnapshotManager({
    persistDir: dir,
    loadEvents: () => new Promise((resolve) => { resolveLoad = resolve; }),
  });

  const bootstrap = await manager.bootstrap();
  assert.equal(bootstrap.freshness.state, "cached");
  assert.equal(bootstrap.events[0].prompt, "cached");
  assert.equal(manager.status().state, "refreshing");

  resolveLoad([{ agent: "codex", type: "user", timestamp: "2026-06-14T10:00:01.000Z", sessionId: "s2", project: "/repo", prompt: "fresh" }]);
  await manager.currentRefresh();
  assert.equal(manager.snapshot().freshness.state, "fresh");
  assert.equal(manager.snapshot().events[0].prompt, "fresh");
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --test snapshot-manager.test.js
```

Expected: fails because `./snapshot-manager` does not exist.

- [ ] **Step 3: Implement manager**

Create `snapshot-manager.js` exposing `createSnapshotManager({ persistDir, loadEvents, buildAggregates })` with methods:

```js
{
  bootstrap({ force } = {}),
  refresh({ force } = {}),
  currentRefresh(),
  snapshot({ agent } = {}),
  status(),
  subscribe(listener),
}
```

Persist `snapshot.json` with `generatedAt` and `events`. Track progress:

```js
{
  state: "idle" | "refreshing" | "complete" | "error",
  startedAt,
  completedAt,
  agents: {},
  totalEvents,
  error,
}
```

- [ ] **Step 4: Add refresh dedupe test**

Append to `snapshot-manager.test.js`:

```js
test("deduplicates concurrent refreshes", async () => {
  let loads = 0;
  const manager = createSnapshotManager({
    loadEvents: async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [];
    },
  });

  await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);
  assert.equal(loads, 1);
});
```

- [ ] **Step 5: Verify green**

Run:

```bash
node --test snapshot-manager.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit snapshot manager**

```bash
git add snapshot-manager.js snapshot-manager.test.js
git commit -m "Add cached-first snapshot manager"
```

## Task 4: Stream Refresh Progress with SSE

**Files:**
- Create: `sse.js`
- Create: `sse.test.js`
- Modify: `snapshot-manager.js`

- [ ] **Step 1: Write failing SSE formatting test**

Create `sse.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeSseEvent } = require("./sse");

test("encodes named SSE events as JSON payloads", () => {
  assert.equal(
    encodeSseEvent("progress", { state: "refreshing" }),
    'event: progress\\ndata: {"state":"refreshing"}\\n\\n',
  );
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --test sse.test.js
```

Expected: fails because `./sse` does not exist.

- [ ] **Step 3: Implement SSE helpers**

Create `sse.js`:

```js
function encodeSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createSseHub() {
  const subscribers = new Set();
  return {
    subscribe(send) {
      subscribers.add(send);
      return () => subscribers.delete(send);
    },
    publish(event, data) {
      for (const send of subscribers) send(encodeSseEvent(event, data));
    },
    size() {
      return subscribers.size;
    },
  };
}

module.exports = { encodeSseEvent, createSseHub };
```

- [ ] **Step 4: Wire manager progress publishing**

Modify `snapshot-manager.js` so `subscribe(listener)` calls the listener immediately with current status and then on every refresh state transition.

- [ ] **Step 5: Verify green**

Run:

```bash
node --test sse.test.js snapshot-manager.test.js
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit SSE support**

```bash
git add sse.js sse.test.js snapshot-manager.js snapshot-manager.test.js
git commit -m "Stream refresh progress events"
```

## Task 5: Replace Express with Bun-Native Server

**Files:**
- Create: `bun-server.js`
- Modify: `server.js`
- Modify: `package.json`

- [ ] **Step 1: Write API smoke test script**

Create a temporary test case or script that starts `bun server.js`, requests `/api/agents`, `/api/bootstrap`, and `/api/refresh-events`, and asserts HTTP 200 plus SSE content type for refresh events.

- [ ] **Step 2: Verify red against missing bootstrap**

Run:

```bash
bun test server-bun.test.js
```

Expected: fails because `/api/bootstrap` and `/api/refresh-events` are not implemented.

- [ ] **Step 3: Implement `Bun.serve` router**

Create `bun-server.js` with:

```js
function startServer({ port, rootDir = __dirname }) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/agents") return json(listAdapters());
      if (url.pathname === "/api/bootstrap") return json(await snapshotManager.bootstrap());
      if (url.pathname === "/api/refresh" && req.method === "POST") return json(await snapshotManager.refresh({ force: url.searchParams.get("force") === "1" }));
      if (url.pathname === "/api/refresh-events") return sseResponse(snapshotManager);
      return serveStatic(rootDir, url.pathname);
    },
  });
}
```

Implement all existing API routes in this router before deleting Express usage.

- [ ] **Step 4: Make `server.js` a thin entry point**

Replace Express setup with:

```js
#!/usr/bin/env bun
require("dotenv").config();
const { startServer } = require("./bun-server");
const { resolvePort } = require("./server-config");

startServer({ port: resolvePort(), rootDir: __dirname });
```

- [ ] **Step 5: Remove Express dependency**

Update `package.json` dependencies to remove `express` after no code imports it.

- [ ] **Step 6: Verify green**

Run:

```bash
bun test server-bun.test.js
npm test
AGENT_LENS_PORT=4567 npm start
curl -s http://localhost:4567/api/bootstrap
```

Expected: tests pass, server starts, bootstrap returns JSON, and existing endpoints still respond.

- [ ] **Step 7: Commit Bun server migration**

```bash
git add bun-server.js server.js package.json package-lock.json server-bun.test.js
git commit -m "Serve dashboard with Bun native HTTP"
```

## Task 6: Update UI for Cached/Fresh Status and SSE Progress

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add visible status elements**

Add markup near the refresh button:

```html
<span id="freshness-badge" class="freshness-badge cached">Cached</span>
<span id="refresh-progress" class="refresh-progress">Waiting for fresh scan...</span>
```

- [ ] **Step 2: Add CSS states**

Add styles for `.freshness-badge.cached`, `.freshness-badge.fresh`, `.freshness-badge.refreshing`, and `.refresh-progress` that are visible but compact in the top bar.

- [ ] **Step 3: Load `/api/bootstrap` first**

Change `load()` so it fetches `/api/bootstrap`, renders agents, renders cached aggregate data if present, then opens SSE:

```js
const bootstrap = await fetch('/api/bootstrap').then(r => r.json());
renderAgentTabs(bootstrap.agents);
if (bootstrap.aggregates) renderSnapshot(bootstrap.aggregates);
connectRefreshEvents();
```

- [ ] **Step 4: Add SSE client**

Implement:

```js
function connectRefreshEvents() {
  const source = new EventSource('/api/refresh-events');
  source.addEventListener('status', (event) => updateRefreshStatus(JSON.parse(event.data)));
  source.addEventListener('progress', (event) => updateRefreshStatus(JSON.parse(event.data)));
  source.addEventListener('complete', async (event) => {
    updateRefreshStatus(JSON.parse(event.data));
    await reload(false);
  });
}
```

- [ ] **Step 5: Make manual refresh use `/api/refresh`**

Update refresh button handler to call:

```js
await fetch('/api/refresh?force=1', { method: 'POST' });
```

Keep the spinner until the SSE complete event arrives.

- [ ] **Step 6: Verify in browser manually**

Start:

```bash
AGENT_LENS_PORT=4567 npm start
```

Open `http://localhost:4567`, confirm cached badge appears first when a snapshot exists, progress text updates per agent, and fresh badge appears after completion.

- [ ] **Step 7: Commit UI refresh status**

```bash
git add index.html
git commit -m "Show cached data and live refresh progress"
```

## Task 7: Optimize Fresh Scan with Evidence

**Files:**
- Modify: `adapters/*.js` only where benchmarks identify bottlenecks
- Modify: `scripts/benchmark-cold-api.js`
- Modify: `scripts/benchmark-api.js`
- Modify: `snapshot-manager.js`
- Modify: `aggregates.js`

- [ ] **Step 1: Add per-agent timing**

Modify refresh loading so progress includes per-agent duration and event count. If `collectEvents` remains shared, change it to emit:

```js
onAgentProgress({ agent: adapter.name, state: "running", startedAt });
onAgentProgress({ agent: adapter.name, state: "done", elapsedMs, eventCount });
```

- [ ] **Step 2: Run benchmark after Bun/SSE migration**

Run:

```bash
npm run benchmark:cold
npm run benchmark
```

Expected: outputs include cached-first and fresh-scan measurements.

- [ ] **Step 3: Optimize the slowest measured path**

Apply only measured improvements. Examples that are valid when benchmarks point there:

```js
const text = await Bun.file(file).text();
```

for large file reads, or precomputed filtered aggregates for agent tabs if filtering dominates.

- [ ] **Step 4: Re-run benchmark and compare**

Run the same commands from Step 2. Record before/after numbers in the final summary.

- [ ] **Step 5: Commit measured optimization**

```bash
git add adapters scripts snapshot-manager.js aggregates.js
git commit -m "Optimize fresh usage scan"
```

## Task 8: Final Verification

**Files:**
- All changed files

- [ ] **Step 1: Run full tests**

```bash
npm test
bun test
```

Expected: all tests pass. If one runner is intentionally unsupported after migration, update `package.json` so the supported test command is explicit and run that command.

- [ ] **Step 2: Run diff and status checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Worktree can contain only intentional final changes before the last commit.

- [ ] **Step 3: Run live API checks**

```bash
AGENT_LENS_PORT=4567 npm start
curl -s http://localhost:4567/api/bootstrap
curl -N http://localhost:4567/api/refresh-events
curl -s -X POST 'http://localhost:4567/api/refresh?force=1'
```

Expected: bootstrap returns cached or fresh snapshot metadata, SSE emits status/progress/complete events, and force refresh completes.

- [ ] **Step 4: Run final benchmarks**

```bash
npm run benchmark:cold
npm run benchmark
```

Expected: cached-first load is faster than the previous cold endpoint baseline and fresh scan timing is documented.

- [ ] **Step 5: Commit final verification updates**

```bash
git status --short
git add .
git commit -m "Finalize Bun-native refresh flow"
```

Only commit if there are intentional changes not already committed by earlier tasks.
