#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const port = process.env.AGENT_LENS_COLD_PORT || "4568";
const defaultEndpoints = "/api/agents,/api/history,/api/daily-costs,/api/metrics";
const endpoints = parseEndpoints();
const rounds = parseInt(process.env.AGENT_LENS_COLD_ROUNDS || "3", 10);
const timeoutMs = parseInt(process.env.AGENT_LENS_COLD_TIMEOUT_MS || "20000", 10);
const settleMs = parseInt(process.env.AGENT_LENS_COLD_SETTLE_MS || "1000", 10);

function parseEndpoints() {
  if (process.env.AGENT_LENS_COLD_ENDPOINT) {
    return [process.env.AGENT_LENS_COLD_ENDPOINT];
  }
  return (process.env.AGENT_LENS_COLD_ENDPOINTS || defaultEndpoints)
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
}

async function waitForServer(child) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/api/agents`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server startup timed out");
}

async function runRound() {
  const child = spawn("bun", ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_LENS_PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(chunk.toString()));

  try {
    await waitForServer(child);
    const timings = {};
    for (const endpoint of endpoints) {
      const started = performance.now();
      const res = await fetch(`http://localhost:${port}${endpoint}`);
      await res.arrayBuffer();
      const ms = performance.now() - started;
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${endpoint}`);
      timings[endpoint] = ms;
    }
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }
    return timings;
  } finally {
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  return { min: sorted[0], avg, max: sorted[sorted.length - 1] };
}

(async () => {
  const samplesByEndpoint = Object.fromEntries(endpoints.map((endpoint) => [endpoint, []]));
  for (let i = 0; i < rounds; i++) {
    const timings = await runRound();
    for (const endpoint of endpoints) {
      samplesByEndpoint[endpoint].push(timings[endpoint]);
    }
    const roundTimings = endpoints
      .map((endpoint) => `${endpoint} ${timings[endpoint].toFixed(1)}ms`)
      .join(" ");
    console.log(`round=${i + 1} ${roundTimings}`);
  }
  for (const endpoint of endpoints) {
    const s = summarize(samplesByEndpoint[endpoint]);
    console.log(
      `summary ${endpoint} min=${s.min.toFixed(1)}ms avg=${s.avg.toFixed(1)}ms max=${s.max.toFixed(1)}ms`,
    );
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
