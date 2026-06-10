const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("deps: THREE.ShapeUtils.triangulateShape and poly2tri load in the sandbox", () => {
  const { THREE, poly2tri } = loadModules();
  assert.ok(THREE && THREE.ShapeUtils && typeof THREE.ShapeUtils.triangulateShape === "function",
    "THREE.ShapeUtils.triangulateShape available");
  assert.ok(poly2tri && poly2tri.SweepContext && poly2tri.Point,
    "poly2tri.SweepContext and poly2tri.Point available");
});
