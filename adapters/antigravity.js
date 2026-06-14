const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadSqlite } = require("./util");

const NAME = "antigravity";
const DISPLAY = "Antigravity";

function defaultDir() {
  const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
  if (fs.existsSync(path.join(cliDir, "conversations"))) return cliDir;
  return path.join(os.homedir(), ".gemini", "antigravity");
}

function dataDir() {
  return process.env.ANTIGRAVITY_DIR || defaultDir();
}

function enabled() {
  return fs.existsSync(path.join(dataDir(), "conversations"));
}

function readableStrings(buf) {
  const out = [];
  let cur = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= 8) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= 8) out.push(cur);
  return out;
}

async function getEvents(emit) {
  const convDir = path.join(dataDir(), "conversations");
  if (!fs.existsSync(convDir)) return;

  const dbFiles = fs.readdirSync(convDir).filter((f) => f.endsWith(".db"));
  if (dbFiles.length) {
    await Promise.all(dbFiles.map((f) => readSqliteConversation(path.join(convDir, f), emit)));
    return;
  }

  const files = fs.readdirSync(convDir).filter((f) => f.endsWith(".pb"));

  await Promise.all(
    files.map(async (f) => {
      const full = path.join(convDir, f);
      let stat;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        return;
      }
      const sessionId = f.replace(/\.pb$/, "");
      const ts = new Date(stat.mtime).toISOString();

      let project = "unknown";
      let prompt = "";
      try {
        const buf = await fs.promises.readFile(full);
        const strings = readableStrings(buf);
        const cwd = strings.find((s) => s.startsWith("/Users/") || s.startsWith("/home/"));
        if (cwd) project = cwd.split(/\s/)[0];
        const firstUserish = strings.find(
          (s) => s.length > 12 && !s.startsWith("/") && !s.includes("://"),
        );
        if (firstUserish) prompt = firstUserish.slice(0, 200);
      } catch {}

      emit({
        agent: NAME,
        timestamp: ts,
        sessionId,
        project,
        type: "user",
        prompt,
      });
      emit({
        agent: NAME,
        timestamp: ts,
        sessionId,
        project,
        type: "assistant",
        model: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      });
    })
  );
}

async function readSqliteConversation(file, emit) {
  const Database = loadSqlite();
  if (!Database) return;

  let db;
  try {
    db = new Database(file, { readonly: true, readOnly: true, fileMustExist: true });
    const stat = await fs.promises.stat(file);
    const timestamp = new Date(stat.mtime).toISOString();
    const sessionId = sessionIdForDb(db, path.basename(file, ".db"));
    const project = projectForDb(db);
    const prompt = promptForDb(db);

    emit({
      agent: NAME,
      timestamp,
      sessionId,
      project,
      type: "user",
      prompt,
    });
    emit({
      agent: NAME,
      timestamp,
      sessionId,
      project,
      type: "assistant",
      model: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    });
  } catch {
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

function sessionIdForDb(db, fallback) {
  try {
    const row = db.prepare("SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1").get();
    return row?.cascade_id || row?.trajectory_id || fallback;
  } catch {
    return fallback;
  }
}

function projectForDb(db) {
  try {
    const rows = db.prepare("SELECT metadata, step_payload FROM steps LIMIT 50").all();
    for (const row of rows) {
      for (const value of [row.metadata, row.step_payload]) {
        if (!value) continue;
        const strings = readableStrings(Buffer.from(value));
        const cwd = strings.find((s) => s.startsWith("/Users/") || s.startsWith("/home/"));
        if (cwd) return cwd.split(/\s/)[0];
      }
    }
  } catch {}
  return "unknown";
}

function promptForDb(db) {
  try {
    const rows = db.prepare("SELECT task_details, step_payload FROM steps LIMIT 50").all();
    for (const row of rows) {
      for (const value of [row.task_details, row.step_payload]) {
        if (!value) continue;
        const strings = readableStrings(Buffer.from(value));
        const first = strings.find((s) => s.length > 12 && !s.startsWith("/") && !s.includes("://"));
        if (first) return first.slice(0, 200);
      }
    }
  } catch {}
  return "";
}

module.exports = { name: NAME, displayName: DISPLAY, dataDir, enabled, getEvents };
