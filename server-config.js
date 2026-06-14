function resolvePort(env = process.env) {
  const raw = env.AGENT_LENS_PORT || "3456";
  return parseInt(raw, 10);
}

module.exports = { resolvePort };
