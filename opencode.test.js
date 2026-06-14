const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const opencode = require("./adapters/opencode");

test("reads OpenCode sqlite data with the built-in sqlite fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-opencode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prior = process.env.OPENCODE_DIR;
  process.env.OPENCODE_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.OPENCODE_DIR;
    else process.env.OPENCODE_DIR = prior;
  });

  const db = new DatabaseSync(path.join(root, "opencode.db"));
  db.exec(`
    CREATE TABLE project (id TEXT, worktree TEXT, name TEXT);
    CREATE TABLE session (id TEXT, project_id TEXT, directory TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO project VALUES (?, ?, ?)").run("project-1", "/tmp/project", "Project");
  db.prepare("INSERT INTO session VALUES (?, ?, ?)").run("session-1", "project-1", "/tmp/project");
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "message-user",
    "session-1",
    1_786_000_000_000,
    JSON.stringify({ role: "user" }),
  );
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
    "message-assistant",
    "session-1",
    1_786_000_001_000,
    JSON.stringify({
      role: "assistant",
      modelID: "gpt-test",
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
      cost: 0.01,
    }),
  );
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
    "message-assistant",
    "session-1",
    1_786_000_002_000,
    JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "pwd" } } }),
  );
  db.close();

  const events = [];
  await opencode.getEvents((event) => events.push(event));

  assert.equal(events.filter((event) => event.type === "user").length, 1);
  assert.equal(events.filter((event) => event.type === "assistant").length, 1);
  assert.equal(events.filter((event) => event.type === "tool").length, 1);
  assert.equal(events.find((event) => event.type === "assistant").tokens.cacheRead, 3);
});

test("prefers an OpenCode database that contains usage rows", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lens-opencode-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const priorHome = process.env.HOME;
  const priorXdg = process.env.XDG_DATA_HOME;
  const priorDir = process.env.OPENCODE_DIR;
  delete process.env.OPENCODE_DIR;
  process.env.HOME = path.join(root, "home");
  process.env.XDG_DATA_HOME = path.join(root, "xdg");
  t.after(() => {
    process.env.HOME = priorHome;
    if (priorXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorXdg;
    if (priorDir === undefined) delete process.env.OPENCODE_DIR;
    else process.env.OPENCODE_DIR = priorDir;
  });

  const emptyDir = path.join(process.env.XDG_DATA_HOME, "opencode");
  const usedDir = path.join(process.env.HOME, ".local", "share", "opencode");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.mkdirSync(usedDir, { recursive: true });

  for (const dir of [emptyDir, usedDir]) {
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT);");
    if (dir === usedDir) {
      db.exec("INSERT INTO session VALUES ('s1'); INSERT INTO message VALUES ('m1');");
    }
    db.close();
  }

  assert.equal(opencode.dataDir(), usedDir);
});
