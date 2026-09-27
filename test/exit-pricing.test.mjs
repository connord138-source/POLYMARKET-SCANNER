import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/autotrader.js", import.meta.url), "utf8");
const grab = (name) => src.match(new RegExp(`(async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`))[0];
const lib = new Function(
  grab("priceForPosition") + grab("isComplementPhantom") + grab("resolveExitPrice") +
  grab("computeExplorationGraduation") + grab("computeGoLiveMilestone") +
  "return { priceForPosition, isComplementPhantom, resolveExitPrice, computeExplorationGraduation, computeGoLiveMilestone };")();
const { priceForPosition, isComplementPhantom, resolveExitPrice, computeExplorationGraduation, computeGoLiveMilestone } = lib;

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

// --- priceForPosition ---
const ld = (price, outcomes) => ({ price, source: "clob_midpoint", outcomes });
check("team 2nd outcome", priceForPosition(ld(67, ["Texas", "Tennessee"]), { directionRaw: "Tennessee" }) === 33);
check("team 1st outcome", priceForPosition(ld(67, ["Texas", "Tennessee"]), { directionRaw: "Texas" }) === 67);
check("no labels, team dir => null (was: 67, the phantom)", priceForPosition(ld(67, undefined), { directionRaw: "Tennessee", direction: "Tennessee" }) === null);
check("no labels, Yes", priceForPosition(ld(22, undefined), { direction: "Yes" }) === 22);
check("no labels, NO uppercase", priceForPosition(ld(22, undefined), { direction: "NO" }) === 78);
check("prefix Under", priceForPosition(ld(40, ["Over", "Under"]), { directionRaw: "Under 8.5" }) === 60);
check("unmatched label => null", priceForPosition(ld(50, ["Chiefs", "Ravens"]), { directionRaw: "Packers" }) === null);

// --- resolveExitPrice ---
const pos = { directionRaw: "Tennessee", entryPrice: 33.5 };
let r = resolveExitPrice(pos, ld(67, ["Texas", "Tennessee"]));
check("resolver live side", r.currentPrice === 33 && r.hasLivePrice && r.priceSource === "clob_midpoint", JSON.stringify(r));
r = resolveExitPrice(pos, undefined);
check("resolver no live => stale at entry (no signal fallback)", r.currentPrice === 33.5 && !r.hasLivePrice && r.priceSource === "stale", JSON.stringify(r));
r = resolveExitPrice(pos, ld(67, undefined));
check("resolver unmatched => stale", !r.hasLivePrice, JSON.stringify(r));

// --- tripwire on the 8 real phantom rows vs real non-phantoms ---
const phantoms = [[20,78,4],[32.5,68,4],[27.5,71,4],[30.5,69,4],[32.5,68,8],[31.5,69,10],[33.5,67,13],[33.5,67,4]];
check("all 8 real phantoms trip", phantoms.every(([e,x,m]) => isComplementPhantom(e, x, m)));
check("Singapore 60m trips only at 90m window", !isComplementPhantom(32.5, 67, 60) && isComplementPhantom(32.5, 67, 60, 90));
check("Leylah 41.5->83 (real move) no trip", !isComplementPhantom(41.5, 83, 70, 90));
check("small move no trip", !isComplementPhantom(45, 55, 5));
check("slow complement no trip", !isComplementPhantom(33, 67, 45));
check("bad input safe", !isComplementPhantom(null, 67, 5) && !isComplementPhantom(33, 67, NaN));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
