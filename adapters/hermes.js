const fs = require("fs");
const os = require("os");
const path = require("path");
const { findFiles, streamJsonl, readJsonSafe } = require("./util");

const NAME = "hermes";
const DISPLAY = "Hermes Agent";
const DEFAULT_DIR = path.join(os.homedir(), ".hermes");

function dataDir() {
  return process.env.HERMES_DIR || DEFAULT_DIR;
}

function enabled() {
  return fs.existsSync(dataDir());
}

async function getEvents(emit) {
  const root = dataDir();

  const roots = [path.join(root, "sessions"), path.join(root, "runs")].filter((dir) => fs.existsSync(dir));
  if (!roots.length) return;

  await Promise.all(
    roots.map(async (rootPath) => {
      const files = await findFiles(rootPath, ".jsonl");
      await Promise.all(
        files.map(async (file) => {
          await streamJsonl(file, (obj) => {
            const ts = obj.timestamp || obj.created_at;
            if (!ts) return;
            const sessionId = obj.sessionId || obj.session_id || path.basename(file, ".jsonl");
            const project = obj.project || "unknown";

            if (obj.type === "user" || obj.role === "user") {
              let prompt = obj.prompt || obj.message || obj.content || "";
              emit({
                agent: NAME,
                timestamp: ts,
                sessionId,
                project,
                type: "user",
                prompt,
              });
            } else if (obj.type === "assistant" || obj.role === "assistant") {
              const usage = obj.usage || {};
              const tokens = {
                input: usage.prompt_tokens || usage.input_tokens || 0,
                output: usage.completion_tokens || usage.output_tokens || 0,
                cacheRead: usage.cache_read_tokens || 0,
                cacheCreate: usage.cache_write_tokens || 0,
              };
              emit({
                agent: NAME,
                timestamp: ts,
                sessionId,
                project,
                type: "assistant",
                model: obj.model || null,
                tokens,
              });

              if (Array.isArray(obj.tool_calls)) {
                for (const tc of obj.tool_calls) {
                  emit({
                    agent: NAME,
                    timestamp: ts,
                    sessionId,
                    project,
                    type: "tool",
                    toolCall: { name: tc.name || tc.function?.name || "tool", input: tc.arguments || tc.input || tc.function?.arguments || {} },
                  });
                }
              }
            }
          });
        })
      );
    })
  );
}

module.exports = { name: NAME, displayName: DISPLAY, dataDir, enabled, getEvents };
