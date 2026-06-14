const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createEventCache } = require("./event-cache");

async function waitForFile(filePath) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

test("deduplicates concurrent loads for the same key", async () => {
  let loads = 0;
  const cache = createEventCache({
    ttlMs: 30_000,
    loadEvents: async (agent) => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ agent: agent || "all" }];
    },
  });

  const [first, second, third] = await Promise.all([
    cache.getEvents("codex"),
    cache.getEvents("codex"),
    cache.getEvents("codex"),
  ]);

  assert.equal(loads, 1);
  assert.deepEqual(first, [{ agent: "codex" }]);
  assert.equal(second, first);
  assert.equal(third, first);
});

test("serves filtered agents from a fresh all-agents cache", async () => {
  let loads = 0;
  const cache = createEventCache({
    ttlMs: 30_000,
    loadEvents: async (agent) => {
      loads++;
      assert.equal(agent || null, null);
      return [
        { agent: "codex", id: 1 },
        { agent: "claude", id: 2 },
        { agent: "codex", id: 3 },
      ];
    },
  });

  await cache.getEvents(null);
  const codex = await cache.getEvents("codex");

  assert.equal(loads, 1);
  assert.deepEqual(codex, [
    { agent: "codex", id: 1 },
    { agent: "codex", id: 3 },
  ]);
});

test("force refresh bypasses a fresh cached value", async () => {
  let loads = 0;
  const cache = createEventCache({
    ttlMs: 30_000,
    loadEvents: async () => [{ version: ++loads }],
  });

  assert.deepEqual(await cache.getEvents(null), [{ version: 1 }]);
  assert.deepEqual(await cache.getEvents(null), [{ version: 1 }]);
  assert.deepEqual(await cache.getEvents(null, { refresh: true }), [{ version: 2 }]);
  assert.deepEqual(await cache.getEvents(null), [{ version: 2 }]);
});

test("deduplicates concurrent force refresh loads", async () => {
  let loads = 0;
  const cache = createEventCache({
    ttlMs: 30_000,
    loadEvents: async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ version: loads }];
    },
  });

  await cache.getEvents(null);
  await Promise.all([
    cache.getEvents(null, { refresh: true }),
    cache.getEvents(null, { refresh: true }),
    cache.getEvents(null, { refresh: true }),
  ]);

  assert.equal(loads, 2);
});

test("loads fresh events from persistent cache on a new cache instance", async (t) => {
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-cache-"));
  t.after(() => fs.rmSync(persistDir, { recursive: true, force: true }));

  let loads = 0;
  const first = createEventCache({
    ttlMs: 30_000,
    persistDir,
    loadEvents: async () => [{ version: ++loads }],
  });
  assert.deepEqual(await first.getEvents(null), [{ version: 1 }]);
  await waitForFile(path.join(persistDir, "all.json"));

  const second = createEventCache({
    ttlMs: 30_000,
    persistDir,
    loadEvents: async () => [{ version: ++loads }],
  });
  assert.deepEqual(await second.getEvents(null), [{ version: 1 }]);
  assert.equal(loads, 1);
});
