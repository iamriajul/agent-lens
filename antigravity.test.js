const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const antigravity = require("./adapters/antigravity");

test("reads Antigravity CLI sqlite conversations", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-antigravity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prior = process.env.ANTIGRAVITY_DIR;
  process.env.ANTIGRAVITY_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.ANTIGRAVITY_DIR;
    else process.env.ANTIGRAVITY_DIR = prior;
  });

  const conversations = path.join(root, "conversations");
  fs.mkdirSync(conversations, { recursive: true });
  const db = new DatabaseSync(path.join(conversations, "conversation-1.db"));
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB);
  `);
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)").run("trajectory-1", "cascade-1", 4, 17);
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(0, 14, 3, Buffer.from("user asked for /tmp/project setup"));
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)").run(1, 15, 3, Buffer.from("assistant responded"));
  db.close();

  const events = [];
  await antigravity.getEvents((event) => events.push(event));

  assert.equal(events.filter((event) => event.type === "user").length, 1);
  assert.equal(events.filter((event) => event.type === "assistant").length, 1);
  assert.equal(events[0].sessionId, "cascade-1");
});
