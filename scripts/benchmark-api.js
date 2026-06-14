#!/usr/bin/env node

const { performance } = require("node:perf_hooks");

const baseUrl = process.env.AGENT_LENS_BENCH_URL || "http://localhost:4567";
const endpoints = [
  "/api/history",
  "/api/projects",
  "/api/tool-calls",
  "/api/daily-costs",
  "/api/metrics",
];
const agents = ["", "codex", "hermes"];
const rounds = parseInt(process.env.AGENT_LENS_BENCH_ROUNDS || "5", 10);

function urlFor(endpoint, agent) {
  const url = new URL(endpoint, baseUrl);
  if (agent) url.searchParams.set("agent", agent);
  return url.toString();
}

async function timeFetch(url) {
  const started = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  const ms = performance.now() - started;
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return ms;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, n) => sum + n, 0);
  return {
    min: sorted[0],
    avg: total / samples.length,
    p95: sorted[Math.ceil(samples.length * 0.95) - 1],
    max: sorted[sorted.length - 1],
  };
}

(async () => {
  console.log(`benchmark base=${baseUrl} rounds=${rounds}`);
  for (const agent of agents) {
    for (const endpoint of endpoints) {
      const label = `${endpoint}${agent ? `?agent=${agent}` : ""}`;
      const samples = [];
      for (let i = 0; i < rounds; i++) {
        samples.push(await timeFetch(urlFor(endpoint, agent)));
      }
      const s = summarize(samples);
      console.log(
        `${label.padEnd(34)} min=${s.min.toFixed(1)}ms avg=${s.avg.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms max=${s.max.toFixed(1)}ms`,
      );
    }
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
