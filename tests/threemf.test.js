const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("extendFilamentConfig adds a filament to every per-filament array + sets colours", () => {
  const { ThreeMF } = loadModules();
  const cfg = JSON.stringify({
    filament_colour: ["#AAAAAAFF", "#BBBBBBFF"],
    filament_type: ["PLA", "PLA"],
    other_two: [1, 2],
    unrelated_three: [9, 9, 9],
    scalar: "x",
  });
  const out = JSON.parse(ThreeMF.extendFilamentConfig(cfg, 2, [{ hex: "#AAAAAA" }, { hex: "#BBBBBB" }, { hex: "#112233" }]));
  assert.deepEqual(out.filament_colour, ["#AAAAAAFF", "#BBBBBBFF", "#112233FF"]);
  assert.deepEqual(out.filament_type, ["PLA", "PLA", "PLA"], "per-filament array gets [0] duplicated");
  assert.deepEqual(out.other_two, [1, 2, 1], "length-2 array extended");
  assert.deepEqual(out.unrelated_three, [9, 9, 9], "length-3 array untouched");
  assert.equal(out.scalar, "x");
});
