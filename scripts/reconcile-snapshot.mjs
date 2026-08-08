#!/usr/bin/env node
/**
 * Reconciliation harness for a ProjectSnapshot's usage/cost figures.
 *
 * Prints a per-session table and a per-model table from an already-generated
 * snapshot (e.g. `buildstory-scan scan --dry-run > snapshot.json`), so a
 * delta against an external usage tool can be attributed to a specific
 * session or model instead of guessed at.
 *
 * Per-session figures are token counts only, never a re-derived dollar
 * amount: session.tokenUsage is a session-wide sum, and pricing that sum in
 * one call would apply a per-response long-context multiplier (see
 * session-pricing.ts's OPENAI_LONG_CONTEXT_INPUT_TOKENS) to the whole
 * session total instead of each individual response - silently inflating
 * high-volume sessions by up to 2x. The per-model table's costMicroUsd is
 * the only authoritative dollar figure: it's summed from the scanner's own
 * per-response pricing during the scan, the same accounting the receipt
 * uses.
 *
 * Usage:
 *   node scripts/reconcile-snapshot.mjs <path-to-snapshot.json>
 *   buildstory-scan scan --repo . --consent local-scan --dry-run --quiet | node scripts/reconcile-snapshot.mjs -
 */

import { readFileSync } from "node:fs";
import { isPricedModel } from "../dist/src/session-pricing.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/reconcile-snapshot.mjs <snapshot.json | ->");
  process.exit(1);
}

const raw = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
/** @type {import("../src/contract.js").ProjectSnapshot} */
const snapshot = JSON.parse(raw);

const usdFormat = new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const microUsd = (value) => (value === null ? "unpriced" : usdFormat.format(value / 1_000_000));

console.log(`Snapshot ${snapshot.scanId} · schema ${snapshot.schemaVersion} · generated ${snapshot.generatedAt}`);
console.log(`Time window: ${snapshot.timeWindow.start} .. ${snapshot.timeWindow.end} (startBasis=${snapshot.timeWindow.startBasis})`);
if (snapshot.usage.coverage) {
  const c = snapshot.usage.coverage;
  console.log(
    `Coverage: ${c.sessionsIncluded}/${c.sessionsDiscovered} sessions included` +
      (c.sessionsSkipped > 0 ? `, ${c.sessionsSkipped} skipped (${c.skipped.map((s) => `${s.reason}=${s.count}`).join(", ")})` : "") +
      (c.partiallyPricedModels > 0 ? `, ${c.partiallyPricedModels} model(s) partially priced` : ""),
  );
}
console.log("");

console.log("=== Sessions (token counts only - see header comment for why cost isn't split per session) ===");
const sessionRows = [...snapshot.sessions]
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  .map((session) => ({
    sessionRef: session.sessionRef,
    provider: session.provider,
    startedAt: session.startedAt,
    turns: session.turns,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    models: session.modelRefs.join(",") || "(none)",
  }));
for (const row of sessionRows) {
  console.log(
    `${row.startedAt}  ${row.sessionRef.slice(0, 16).padEnd(16)}  ${row.provider.padEnd(11)}  turns=${String(row.turns).padStart(4)}  tokens=${String(row.totalTokens).padStart(9)}  ${row.models}`,
  );
}
console.log(`Total sessions: ${sessionRows.length}`);
console.log("");

console.log("=== Models (authoritative cost figures) ===");
for (const model of [...snapshot.usage.models].sort((a, b) => (b.costMicroUsd ?? 0) - (a.costMicroUsd ?? 0))) {
  console.log(
    `${model.provider}/${model.name}`.padEnd(30) +
      `  turns=${String(model.turnCount).padStart(5)}` +
      `  tokens=${String(model.tokenUsage?.totalTokens ?? 0).padStart(10)}` +
      `  cost=${microUsd(model.costMicroUsd).padStart(10)}` +
      `  priced=${isPricedModel(model.name)}`,
  );
}
console.log("");
console.log(`Total: ${microUsd(snapshot.usage.cost.totalMicroUsd)}  (priced tokens: ${snapshot.usage.cost.pricedTokens.toLocaleString()}, unpriced: ${snapshot.usage.cost.unpricedTokens.toLocaleString()}, pricing table ${snapshot.usage.cost.pricingTableVersion})`);
