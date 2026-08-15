import assert from "node:assert/strict";
import test from "node:test";
import { formatTokens, studioReportUrl, wrap } from "../src/tui/format.js";

test("wrap splits words longer than the terminal width", () => {
  const lines = wrap("AI-assisteder", 8);
  assert.deepEqual(lines, ["AI-assis", "teder"]);
});

test("formatTokens uses billions instead of thousands of millions", () => {
  assert.equal(formatTokens(4_821_900_000), "4.8B");
  assert.equal(formatTokens(12_300), "12.3K");
  assert.equal(formatTokens(42), "42");
});

test("studioReportUrl maps a CLI report endpoint onto the studio page", () => {
  assert.equal(
    studioReportUrl("https://buildstory.dev", "https://buildstory.dev/api/v1/cli/reports/rpt_abc"),
    "https://buildstory.dev/studio/reports/rpt_abc",
  );
});
