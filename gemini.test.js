const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const gemini = require("./adapters/gemini");

test("reads Gemini JSONL chat sessions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-gemini-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prior = process.env.GEMINI_DIR;
  process.env.GEMINI_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.GEMINI_DIR;
    else process.env.GEMINI_DIR = prior;
  });

  const chats = path.join(root, "tmp", "proj", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(chats, "session.jsonl"),
    [
      JSON.stringify({ sessionId: "session-1", kind: "main" }),
      JSON.stringify({ id: "u1", timestamp: "2026-06-08T09:00:00.000Z", type: "user", content: [{ text: "hello" }] }),
      JSON.stringify({
        id: "a1",
        timestamp: "2026-06-08T09:00:01.000Z",
        type: "gemini",
        model: "gemini-test",
        tokens: { input: 10, output: 5, cached: 2, thoughts: 1 },
        toolCalls: [{ name: "read_file", args: { file_path: "README.md" } }],
      }),
    ].join("\n"),
  );

  const events = [];
  await gemini.getEvents((event) => events.push(event));

  assert.equal(events.filter((event) => event.type === "user").length, 1);
  assert.equal(events.filter((event) => event.type === "assistant").length, 1);
  assert.equal(events.filter((event) => event.type === "tool").length, 1);
  assert.equal(events.find((event) => event.type === "assistant").tokens.cacheRead, 2);
});
