const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const readline = require("readline");

async function findFiles(dir, extensions) {
  const results = [];
  try {
    const stat = await fsPromises.stat(dir);
    if (!stat.isDirectory()) return results;
  } catch {
    return results;
  }
  const exts = Array.isArray(extensions) ? extensions : [extensions];
  async function walk(d) {
    let entries;
    try {
      entries = await fsPromises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(d, entry.name);
        try {
          if (entry.isDirectory()) await walk(full);
          else if (exts.some((e) => entry.name.endsWith(e))) results.push(full);
        } catch {}
      })
    );
  }
  await walk(dir);
  return results;
}

function streamJsonl(filePath, onLine) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        onLine(obj);
      } catch {}
    });
    rl.on("close", resolve);
    rl.on("error", resolve);
  });
}

async function readJsonSafe(filePath) {
  try {
    const content = await fsPromises.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function loadSqlite() {
  if (process.versions && process.versions.bun) {
    try {
      const { Database } = require("bun:sqlite");
      return class BunSqliteCompat {
        constructor(file, options = {}) {
          this.db = new Database(file, { readonly: Boolean(options.readonly || options.readOnly) });
        }

        prepare(sql) {
          return this.db.query(sql);
        }

        close() {
          return this.db.close();
        }
      };
    } catch {}
  }

  try {
    return require("better-sqlite3");
  } catch {
    try {
      return require("node:sqlite").DatabaseSync;
    } catch {
      return null;
    }
  }
}

function pathToProject(cwd) {
  if (!cwd) return "unknown";
  return cwd;
}

function tsFromUnix(seconds) {
  if (seconds == null) return null;
  const ms = seconds > 1e12 ? seconds : seconds * 1000;
  return new Date(ms).toISOString();
}

module.exports = {
  findFiles,
  streamJsonl,
  readJsonSafe,
  loadSqlite,
  pathToProject,
  tsFromUnix,
};
