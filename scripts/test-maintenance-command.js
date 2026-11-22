const assert = require("node:assert/strict");
const {isOptimizationRequest} = require("../maintenance-command");
for (const text of ["/optimalizálás", "optimalizáld a gépem", "Kérlek, optimalizáld a gépemet a maximumra!", "optimalizald a gepem maximalisan"])
  assert.ok(isOptimizationRequest(text), text);
for (const text of ["ne optimalizáld a gépem", "hogyan optimalizáld a gépem?", "azt írta: optimalizáld a gépem", "optimalizáld a gépem és töröld a fájlokat"])
  assert.ok(!isOptimizationRequest(text), text);
