const assert = require("node:assert/strict");
const test = require("node:test");

const { resolvePort } = require("./server-config");

test("defaults to the documented dashboard port when ambient PORT is set", () => {
  assert.equal(resolvePort({ PORT: "13500" }), 3456);
});

test("uses AGENT_LENS_PORT as the explicit dashboard port override", () => {
  assert.equal(resolvePort({ PORT: "13500", AGENT_LENS_PORT: "4567" }), 4567);
});
