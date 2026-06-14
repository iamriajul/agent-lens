const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const hermes = require("./adapters/hermes");

test("reads role-based Hermes session logs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-hermes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prior = process.env.HERMES_DIR;
  process.env.HERMES_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.HERMES_DIR;
    else process.env.HERMES_DIR = prior;
  });

  const sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "20260608_test.jsonl"),
    [
      JSON.stringify({ role: "user", content: "Show Hermes stats", timestamp: "2026-06-08T10:00:00.000Z" }),
      JSON.stringify({
        role: "assistant",
        content: "Done",
        model: "test-model",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 },
        tool_calls: [{ name: "read_file", input: { path: "README.md" } }],
        timestamp: "2026-06-08T10:00:01.000Z",
      }),
    ].join("\n"),
  );

  const events = [];
  await hermes.getEvents((event) => events.push(event));

  assert.equal(events.filter((event) => event.type === "user").length, 1);
  assert.equal(events.filter((event) => event.type === "assistant").length, 1);
  assert.equal(events.filter((event) => event.type === "tool").length, 1);
  assert.equal(events.find((event) => event.type === "user").prompt, "Show Hermes stats");
});
