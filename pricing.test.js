const assert = require("node:assert/strict");
const test = require("node:test");

function loadPricingWith(models) {
  delete require.cache[require.resolve("./pricing")];
  const priorFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: models }),
  });
  const pricing = require("./pricing");
  return {
    pricing,
    restore: () => {
      global.fetch = priorFetch;
      delete require.cache[require.resolve("./pricing")];
    },
  };
}

test("caches repeated model price lookups", async (t) => {
  const { pricing, restore } = loadPricingWith([
    {
      id: "anthropic/claude-sonnet-4",
      pricing: { prompt: "0.000003", completion: "0.000015" },
    },
  ]);
  t.after(restore);

  await pricing.refreshIfStale();

  assert.equal(pricing.priceFor("claude", "claude-sonnet-4").input, 0.000003);
  assert.equal(pricing.snapshot().lookupCacheSize, 1);

  assert.equal(pricing.priceFor("claude", "claude-sonnet-4").input, 0.000003);
  assert.equal(pricing.snapshot().lookupCacheSize, 1);
});
