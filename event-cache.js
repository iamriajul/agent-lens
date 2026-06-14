const fs = require("node:fs");
const path = require("node:path");

function createEventCache({ ttlMs, loadEvents, persistDir = null }) {
  const cache = new Map();

  function cacheFile(key) {
    if (!persistDir) return null;
    return path.join(persistDir, `${encodeURIComponent(key)}.json`);
  }

  function isFresh(entry, now) {
    return Boolean(entry && entry.events && now - entry.ts < ttlMs);
  }

  function readPersistent(key, now) {
    const file = cacheFile(key);
    if (!file) return null;
    try {
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isFresh(entry, now)) {
        cache.set(key, entry);
        return entry.events;
      }
    } catch {}
    return null;
  }

  async function writePersistent(key, entry) {
    const file = cacheFile(key);
    if (!file) return;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(entry));
      await fs.promises.rename(tmp, file);
    } catch {}
  }

  async function getEvents(agentFilter, options = {}) {
    const key = agentFilter || "all";
    const now = Date.now();
    const cached = cache.get(key);
    const refresh = Boolean(options.refresh);

    if (!refresh && isFresh(cached, now)) {
      return cached.events;
    }

    if (!refresh) {
      const persisted = readPersistent(key, now);
      if (persisted) return persisted;
    }

    if (!refresh && agentFilter) {
      const all = cache.get("all");
      if (isFresh(all, now)) {
        const events = all.events.filter((event) => event.agent === agentFilter);
        cache.set(key, { events, ts: all.ts });
        return events;
      }
    }

    if (cached && cached.promise) {
      return cached.promise;
    }

    const promise = loadEvents(agentFilter)
      .then((events) => {
        const entry = { events, ts: Date.now() };
        cache.set(key, entry);
        void writePersistent(key, entry);
        return events;
      })
      .catch((err) => {
        cache.delete(key);
        throw err;
      });

    cache.set(key, { promise, ts: now });
    return promise;
  }

  return { getEvents };
}

module.exports = { createEventCache };
