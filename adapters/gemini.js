const fs = require("fs");
const os = require("os");
const path = require("path");
const { findFiles, readJsonSafe, streamJsonl } = require("./util");

const NAME = "gemini";
const DISPLAY = "Gemini CLI";
const DEFAULT_DIR = path.join(os.homedir(), ".gemini");

function dataDir() {
  return process.env.GEMINI_DIR || DEFAULT_DIR;
}

function enabled() {
  return fs.existsSync(path.join(dataDir(), "tmp"));
}

async function getEvents(emit) {
  const tmpDir = path.join(dataDir(), "tmp");
  if (!fs.existsSync(tmpDir)) return;

  const projects = fs
    .readdirSync(tmpDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  await Promise.all(
    projects.map(async (proj) => {
      const projPath = path.join(tmpDir, proj.name);
      const projectName = proj.name;

      const chatsDir = path.join(projPath, "chats");
      if (fs.existsSync(chatsDir)) {
        const files = await findFiles(chatsDir, [".json", ".jsonl"]);
        await Promise.all(
          files.map(async (file) => {
            const emitMessage = (m, sessionId) => {
              const ts = m.timestamp;
              if (!ts) return;
              const type = m.type;

              if (type === "user") {
                let prompt = "";
                const c = m.content;
                if (typeof c === "string") prompt = c;
                else if (Array.isArray(c)) {
                  const t = c.find((x) => x && x.text);
                  if (t) prompt = t.text;
                }
                emit({
                  agent: NAME,
                  timestamp: ts,
                  sessionId,
                  project: projectName,
                  type: "user",
                  prompt,
                });
              } else if (type === "gemini") {
                const tk = m.tokens || {};
                const tokens = {
                  input: Math.max(0, (tk.input || 0) - (tk.cached || 0)),
                  output: (tk.output || 0) + (tk.thoughts || 0),
                  cacheRead: tk.cached || 0,
                  cacheCreate: 0,
                  reasoning: tk.thoughts || 0,
                };
                emit({
                  agent: NAME,
                  timestamp: ts,
                  sessionId,
                  project: projectName,
                  type: "assistant",
                  model: m.model || null,
                  tokens,
                });

                if (Array.isArray(m.toolCalls)) {
                  for (const tc of m.toolCalls) {
                    emit({
                      agent: NAME,
                      timestamp: tc.timestamp || ts,
                      sessionId,
                      project: projectName,
                      type: "tool",
                      toolCall: {
                        name: tc.displayName || tc.name || "tool",
                        input: tc.args || {},
                      },
                    });
                  }
                }
              }
            };

            if (file.endsWith(".jsonl")) {
              let sessionId = path.basename(file, ".jsonl");
              await streamJsonl(file, (m) => {
                if (m.sessionId && !m.timestamp) sessionId = m.sessionId;
                emitMessage(m, sessionId);
              });
              return;
            }

            const data = await readJsonSafe(file);
            if (!data || !Array.isArray(data.messages)) return;
            const sessionId = data.sessionId || path.basename(file);

            for (const m of data.messages) {
              emitMessage(m, sessionId);
            }
          })
        );
      }

      const logsPath = path.join(projPath, "logs.json");
      if (fs.existsSync(logsPath)) {
        const logs = await readJsonSafe(logsPath);
        if (Array.isArray(logs)) {
          for (const l of logs) {
            if (l.type === "user" && l.timestamp && l.message) {
              emit({
                agent: NAME,
                timestamp: l.timestamp,
                sessionId: l.sessionId || "",
                project: projectName,
                type: "user_log",
                prompt: l.message,
              });
            }
          }
        }
      }
    })
  );
}

module.exports = { name: NAME, displayName: DISPLAY, dataDir, enabled, getEvents };
