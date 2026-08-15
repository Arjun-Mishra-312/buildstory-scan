import type { ProjectSnapshot, SessionSummary, UsageSummary } from "../contract.js";
import { theme } from "./theme.js";

export const MAX_DAILY_COLUMNS = 40;
export const MAX_SHARE_MODELS = 8;

export type ReceiptTiles = {
  spendMicroUsd: number | null;
  totalTokens: number;
  sessionCount: number;
  topSpendModel: string | null;
};

export type ModelShareRow = {
  name: string;
  percent: number;
  costMicroUsd: number;
  colorIndex: number;
};

export type DailySpendColumn = {
  day: string;
  spendMicroUsd: number;
  sessions: number;
  topModel: string | null;
  colorIndex: number;
  unpriced: boolean;
};

export type DailySpendSeries = {
  columns: DailySpendColumn[];
  estimated: boolean;
};

export function truncateModelName(name: string, max = 18): string {
  if (name.length <= max) return name;
  return `${name.slice(0, Math.max(1, max - 1))}…`;
}

function modelColorIndex(name: string, paletteLength: number): number {
  const known = ["claude-opus-5", "claude-sonnet-5", "glm-5.2", "codex-auto-review", "gpt-5.6-luna", "gpt-5.6-sol"];
  const index = known.indexOf(name);
  if (index >= 0) return index % paletteLength;
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % paletteLength;
  return hash;
}

function microUsdPerToken(model: UsageSummary["models"][number]): number | null {
  if (model.costMicroUsd === null || !model.tokenUsage || model.tokenUsage.totalTokens <= 0) return null;
  return model.costMicroUsd / model.tokenUsage.totalTokens;
}

function lookupRate(models: UsageSummary["models"], name: string): number | null {
  const exact = models.find((model) => model.name === name);
  if (exact) return microUsdPerToken(exact);
  const prefix = models.find((model) => name.startsWith(model.name) || model.name.startsWith(name));
  return prefix ? microUsdPerToken(prefix) : null;
}

export function receiptTiles(snapshot: ProjectSnapshot): ReceiptTiles {
  let top: { name: string; cost: number } | null = null;
  for (const model of snapshot.usage.models) {
    if (model.costMicroUsd === null) continue;
    if (!top || model.costMicroUsd > top.cost) top = { name: model.name, cost: model.costMicroUsd };
  }
  return {
    spendMicroUsd: snapshot.usage.cost.totalMicroUsd,
    totalTokens: snapshot.usage.tokenUsage?.totalTokens ?? 0,
    sessionCount: snapshot.sessions.length,
    topSpendModel: top?.name ?? null,
  };
}

export function modelSpendShare(snapshot: ProjectSnapshot): {
  rows: ModelShareRow[];
  unpricedTokenPercent: number | null;
} {
  const priced = snapshot.usage.models
    .filter((model) => model.costMicroUsd !== null && model.costMicroUsd > 0)
    .sort((left, right) => (right.costMicroUsd ?? 0) - (left.costMicroUsd ?? 0));
  const total = priced.reduce((sum, model) => sum + (model.costMicroUsd ?? 0), 0);
  const rows = priced.slice(0, MAX_SHARE_MODELS).map((model, index) => ({
    name: model.name,
    percent: total > 0 ? Math.round(((model.costMicroUsd ?? 0) / total) * 1000) / 10 : 0,
    costMicroUsd: model.costMicroUsd ?? 0,
    colorIndex: index,
  }));
  const tokens = snapshot.usage.tokenUsage?.totalTokens ?? 0;
  const unpriced = snapshot.usage.cost.unpricedTokens;
  const unpricedTokenPercent = tokens > 0 && unpriced > 0
    ? Math.round((unpriced / tokens) * 1000) / 10
    : null;
  return { rows, unpricedTokenPercent };
}

function primaryModel(session: SessionSummary): string {
  return session.modelRefs[0] ?? "unknown";
}

export function downsampleDays<T>(days: T[], maxColumns = MAX_DAILY_COLUMNS): T[] {
  if (days.length <= maxColumns) return days;
  const step = days.length / maxColumns;
  const picked: T[] = [];
  for (let index = 0; index < maxColumns; index += 1) {
    const source = days[Math.min(days.length - 1, Math.floor(index * step))];
    if (source !== undefined) picked.push(source);
  }
  return picked;
}

export function dailySpendSeries(snapshot: ProjectSnapshot, maxColumns = MAX_DAILY_COLUMNS): DailySpendSeries {
  const buckets = new Map<string, { spendMicroUsd: number; sessions: number; byModel: Map<string, number> }>();
  for (const session of snapshot.sessions) {
    const day = session.startedAt.slice(0, 10);
    const bucket = buckets.get(day) ?? { spendMicroUsd: 0, sessions: 0, byModel: new Map() };
    bucket.sessions += 1;
    const model = primaryModel(session);
    const tokens = session.tokenUsage?.totalTokens ?? 0;
    const rate = lookupRate(snapshot.usage.models, model);
    if (tokens > 0 && rate !== null) {
      const spend = tokens * rate;
      bucket.spendMicroUsd += spend;
      bucket.byModel.set(model, (bucket.byModel.get(model) ?? 0) + spend);
    }
    buckets.set(day, bucket);
  }
  const raw: DailySpendColumn[] = Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, bucket]) => {
      let topModel: string | null = null;
      let topSpend = -1;
      for (const [name, spend] of bucket.byModel) {
        if (spend > topSpend) {
          topSpend = spend;
          topModel = name;
        }
      }
      return {
        day,
        spendMicroUsd: bucket.spendMicroUsd,
        sessions: bucket.sessions,
        topModel: topSpend > 0 ? topModel : null,
        colorIndex: topModel ? modelColorIndex(topModel, theme.bar.length) : 0,
        unpriced: bucket.spendMicroUsd <= 0,
      };
    });
  return { columns: downsampleDays(raw, maxColumns), estimated: snapshot.sessions.length > 0 };
}

export function sessionHourSparkline(sessions: SessionSummary[]): string {
  const hours = Array.from({ length: 24 }, () => 0);
  for (const session of sessions) {
    const hour = Number.parseInt(session.startedAt.slice(11, 13), 10);
    if (hour >= 0 && hour <= 23) hours[hour] = (hours[hour] ?? 0) + 1;
  }
  const peak = Math.max(1, ...hours);
  return hours.map((count) => {
    if (count <= 0) return "·";
    return count / peak >= 0.5 ? "#" : "+";
  }).join("");
}

export function barWidth(value: number, peak: number, maxWidth: number): number {
  if (peak <= 0 || value <= 0) return 0;
  return Math.max(1, Math.round((value / peak) * maxWidth));
}
