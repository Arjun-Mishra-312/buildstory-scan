import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectSnapshot, SessionSummary, TokenUsage, UsageSummary } from "../src/contract.js";
import { DASHBOARD_NAV } from "../src/tui/chrome.js";
import {
  dailySpendSeries,
  downsampleDays,
  modelSpendShare,
  receiptTiles,
  sessionHourSparkline,
  truncateModelName,
} from "../src/tui/receipt-metrics.js";

function tokens(total: number): TokenUsage {
  return {
    inputTokens: total,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: total,
  };
}

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "startedAt" | "sessionRef">): SessionSummary {
  return {
    provider: "codex",
    sourceKind: "active",
    endedAt: overrides.startedAt,
    status: "completed",
    workingDirectoryRelation: "repository-root",
    summary: "",
    turns: 1,
    assistantMessages: 1,
    toolCalls: 0,
    modelRefs: ["claude-opus-5"],
    toolRefs: [],
    tokenUsage: tokens(1_000),
    ...overrides,
  };
}

function snapshot(models: UsageSummary["models"], sessions: SessionSummary[], unpricedTokens = 0): ProjectSnapshot {
  const totalMicroUsd = models.reduce<number | null>((sum, model) => {
    if (model.costMicroUsd === null) return sum;
    return (sum ?? 0) + model.costMicroUsd;
  }, null);
  const totalTokens = models.reduce((sum, model) => sum + (model.tokenUsage?.totalTokens ?? 0), 0);
  return {
    usage: {
      tools: [],
      models,
      totalToolCalls: 0,
      totalTurns: 0,
      tokenUsage: tokens(totalTokens),
      cost: {
        totalMicroUsd,
        pricedTokens: Math.max(0, totalTokens - unpricedTokens),
        unpricedTokens,
        pricingTableVersion: "test",
      },
    },
    sessions,
  } as unknown as ProjectSnapshot;
}

test("nav puts Receipt on key 1 and Story on key 2", () => {
  assert.deepEqual(DASHBOARD_NAV.map((item) => [item.key, item.id]), [
    ["1", "receipt"],
    ["2", "story"],
    ["3", "sessions"],
    ["4", "signals"],
    ["5", "evidence"],
  ]);
});

test("truncateModelName ellipsizes instead of wrapping a trailing -5", () => {
  assert.equal(truncateModelName("claude-opus-5", 18), "claude-opus-5");
  assert.equal(truncateModelName("claude-sonnet-5-thinking-high", 18), "claude-sonnet-5-t…");
  assert.ok(!truncateModelName("gpt-5.6-sol-medium-extra", 12).includes("\n"));
});

test("receiptTiles picks the highest costMicroUsd model", () => {
  const tiles = receiptTiles(snapshot([
    { provider: "anthropic", name: "claude-sonnet-5", turnCount: 10, sessionCount: 2, tokenUsage: tokens(2_000), costMicroUsd: 1_000_000 },
    { provider: "anthropic", name: "claude-opus-5", turnCount: 4, sessionCount: 1, tokenUsage: tokens(1_000), costMicroUsd: 4_000_000 },
  ], []));
  assert.equal(tiles.topSpendModel, "claude-opus-5");
  assert.equal(tiles.spendMicroUsd, 5_000_000);
  assert.equal(tiles.totalTokens, 3_000);
});

test("receiptTiles reports unpriced when every model cost is null", () => {
  const tiles = receiptTiles(snapshot([
    { provider: "local", name: "mystery", turnCount: 2, sessionCount: 1, tokenUsage: tokens(500), costMicroUsd: null },
  ], []));
  assert.equal(tiles.topSpendModel, null);
  assert.equal(tiles.spendMicroUsd, null);
});

test("modelSpendShare is percent of priced cost, with unpriced token share last", () => {
  const share = modelSpendShare(snapshot([
    { provider: "anthropic", name: "claude-opus-5", turnCount: 1, sessionCount: 1, tokenUsage: tokens(4_300), costMicroUsd: 4_300_000 },
    { provider: "anthropic", name: "claude-sonnet-5", turnCount: 1, sessionCount: 1, tokenUsage: tokens(5_700), costMicroUsd: 5_700_000 },
  ], [], 2_000));
  assert.equal(share.rows[0]?.name, "claude-sonnet-5");
  assert.equal(share.rows[0]?.percent, 57);
  assert.equal(share.rows[1]?.percent, 43);
  assert.equal(share.unpricedTokenPercent, 20);
});

test("dailySpendSeries buckets UTC days and attributes tokens to modelRefs[0]", () => {
  const series = dailySpendSeries(snapshot(
    [
      { provider: "anthropic", name: "claude-opus-5", turnCount: 2, sessionCount: 2, tokenUsage: tokens(2_000), costMicroUsd: 2_000_000 },
    ],
    [
      session({ sessionRef: "a", startedAt: "2026-08-01T10:00:00Z", modelRefs: ["claude-opus-5"], tokenUsage: tokens(1_000) }),
      session({ sessionRef: "b", startedAt: "2026-08-01T22:00:00Z", modelRefs: ["claude-opus-5"], tokenUsage: tokens(1_000) }),
      session({ sessionRef: "c", startedAt: "2026-08-02T01:00:00Z", modelRefs: ["unknown"], tokenUsage: tokens(9_000) }),
    ],
  ));
  assert.equal(series.estimated, true);
  assert.equal(series.columns.length, 2);
  assert.equal(series.columns[0]?.day, "2026-08-01");
  assert.equal(series.columns[0]?.sessions, 2);
  assert.equal(series.columns[0]?.spendMicroUsd, 2_000_000);
  assert.equal(series.columns[0]?.topModel, "claude-opus-5");
  assert.equal(series.columns[1]?.unpriced, true);
  assert.equal(series.columns[1]?.sessions, 1);
});

test("downsampleDays keeps at most the requested columns", () => {
  const days = Array.from({ length: 80 }, (_, index) => index);
  const picked = downsampleDays(days, 40);
  assert.equal(picked.length, 40);
  assert.equal(picked[0], 0);
  assert.equal(picked.at(-1), 78);
});

test("sessionHourSparkline marks hours that had sessions", () => {
  const spark = sessionHourSparkline([
    session({ sessionRef: "a", startedAt: "2026-08-01T00:15:00Z" }),
    session({ sessionRef: "b", startedAt: "2026-08-01T00:45:00Z" }),
    session({ sessionRef: "c", startedAt: "2026-08-01T12:00:00Z" }),
  ]);
  assert.equal(spark.length, 24);
  assert.equal(spark[0], "#");
  assert.equal(spark[12], "#");
  assert.equal(spark[1], "·");
});
