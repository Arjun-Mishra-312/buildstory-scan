import type { GitAggregateMetrics, NarrativeEvidenceBundle, Signal, SessionSummary, StoryPackSource, UsageSummary } from "../contract.js";

export type { Signal, SignalFamily } from "../contract.js";

export type SignalInputs = {
  sessions: SessionSummary[];
  usage: UsageSummary;
  git: GitAggregateMetrics;
  timeWindow?: { utcOffsetMinutes?: number } | undefined;
  narrativeEvidence?: NarrativeEvidenceBundle | undefined;
  /** Pre-minted via buildStoryPackSources - signals never re-derive ref allocation. */
  sources: StoryPackSource[];
};

const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4]);

function localHour(timestamp: string, utcOffsetMinutes: number): number {
  const utcMillis = Date.parse(timestamp);
  if (!Number.isFinite(utcMillis)) return 0;
  return new Date(utcMillis + utcOffsetMinutes * 60_000).getUTCHours();
}

function localDayKey(timestamp: string, utcOffsetMinutes: number): string {
  const utcMillis = Date.parse(timestamp);
  if (!Number.isFinite(utcMillis)) return timestamp.slice(0, 10);
  return new Date(utcMillis + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function localWeekday(timestamp: string, utcOffsetMinutes: number): number {
  const utcMillis = Date.parse(timestamp);
  if (!Number.isFinite(utcMillis)) return 0;
  return new Date(utcMillis + utcOffsetMinutes * 60_000).getUTCDay();
}

function durationMinutes(session: SessionSummary): number {
  return Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000));
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function sourceRefFor(sessionRef: string, sources: StoryPackSource[]): string[] {
  const ref = sources.find((source) => source.sessionRef === sessionRef)?.ref;
  return ref ? [ref] : [];
}

// Every threshold below is a deliberate floor, not a magic number: it exists
// to keep thin or unremarkable windows quiet rather than manufacturing a
// "fact" out of noise. Each family's notability score is its own simple,
// documented heuristic - there is no single generic formula, matching how
// profile.ts gives every score dimension its own explicit formula string.

function rhythmSignals(inputs: SignalInputs): Signal[] {
  const offset = inputs.timeWindow?.utcOffsetMinutes ?? 0;
  const sessions = inputs.sessions;
  if (sessions.length === 0) return [];
  const signals: Signal[] = [];

  const nightCount = sessions.filter((session) => NIGHT_HOURS.has(localHour(session.startedAt, offset))).length;
  const nightShare = pct(nightCount, sessions.length);
  if (nightShare >= 20) {
    signals.push({
      id: "night-owl-share", family: "rhythm",
      headline: `${nightShare}% of your sessions started between 10pm and 5am`,
      detail: `${nightCount} of ${sessions.length} sessions began in that window.`,
      value: nightShare, unit: "%", notability: Math.min(100, Math.round(nightShare * 1.5)),
      formula: "round(100 * nightSessions / sessions)",
      sourceRefs: [],
    });
  }

  const durations = sessions.map((session) => ({ session, minutes: durationMinutes(session) }));
  const longest = durations.reduce((best, item) => item.minutes > best.minutes ? item : best, durations[0]!);
  const medianMinutes = median(durations.map((item) => item.minutes));
  if (longest.minutes >= 60 && medianMinutes > 0 && longest.minutes >= medianMinutes * 2) {
    const hours = Math.floor(longest.minutes / 60);
    const minutes = longest.minutes % 60;
    signals.push({
      id: "longest-session", family: "rhythm",
      headline: `Your longest session ran ${hours}h ${minutes}m`,
      detail: `Started at ${formatHour(localHour(longest.session.startedAt, offset))} local time - ${round1(longest.minutes / medianMinutes)}x your median session.`,
      value: longest.minutes, unit: "minutes", notability: Math.min(100, Math.round((longest.minutes / medianMinutes) * 15)),
      formula: "longestSessionMinutes vs medianSessionMinutes",
      sourceRefs: sourceRefFor(longest.session.sessionRef, inputs.sources),
    });
  }

  const dayCounts = new Map<string, number>();
  for (const session of sessions) {
    const key = localDayKey(session.startedAt, offset);
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }
  const busiest = [...dayCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  if (busiest && busiest[1] >= 3 && busiest[1] >= sessions.length * 0.25) {
    const share = pct(busiest[1], sessions.length);
    signals.push({
      id: "busiest-day", family: "rhythm",
      headline: `Your busiest day was ${busiest[0]}, with ${busiest[1]} sessions`,
      detail: `That's ${share}% of every session in this build.`,
      value: busiest[1], unit: "sessions", notability: Math.min(100, Math.round(share * 1.5)),
      formula: "max(sessionsByLocalDay)",
      sourceRefs: [],
    });
  }

  const weekendCount = sessions.filter((session) => [0, 6].includes(localWeekday(session.startedAt, offset))).length;
  const weekendShare = pct(weekendCount, sessions.length);
  if (weekendShare >= 30) {
    signals.push({
      id: "weekend-share", family: "rhythm",
      headline: `${weekendShare}% of your sessions happened on a weekend`,
      detail: `${weekendCount} of ${sessions.length} sessions.`,
      value: weekendShare, unit: "%", notability: Math.min(100, Math.round(weekendShare * 1.2)),
      formula: "round(100 * weekendSessions / sessions)",
      sourceRefs: [],
    });
  }

  if (sessions.length >= 4) {
    const sortedStarts = sessions.map((session) => Date.parse(session.startedAt)).sort((left, right) => left - right);
    let maxGapMs = 0;
    for (let index = 1; index < sortedStarts.length; index += 1) {
      maxGapMs = Math.max(maxGapMs, sortedStarts[index]! - sortedStarts[index - 1]!);
    }
    const gapDays = maxGapMs / (24 * 60 * 60 * 1000);
    if (gapDays >= 2) {
      signals.push({
        id: "longest-gap", family: "rhythm",
        headline: `You took a ${Math.round(gapDays)}-day break mid-build`,
        detail: "The longest stretch between two consecutive sessions in this window.",
        value: Math.round(gapDays), unit: "days", notability: Math.min(100, Math.round(gapDays * 8)),
        formula: "max(gap between consecutive session starts)",
        sourceRefs: [],
      });
    }
  }

  return signals;
}

function toolingSignals(inputs: SignalInputs): Signal[] {
  const { usage } = inputs;
  const signals: Signal[] = [];
  const totalCalls = usage.totalToolCalls || usage.tools.reduce((sum, tool) => sum + tool.callCount, 0);
  const topTool = [...usage.tools].sort((left, right) => right.callCount - left.callCount || left.name.localeCompare(right.name))[0];
  if (topTool && totalCalls > 0 && topTool.callCount >= 10) {
    const share = pct(topTool.callCount, totalCalls);
    signals.push({
      id: "tool-dominance", family: "tooling",
      headline: `You called ${topTool.name} ${topTool.callCount} times`,
      detail: `That's ${share}% of every tool call across this build.`,
      value: topTool.callCount, unit: "calls", notability: Math.min(100, Math.round(share * 1.3)),
      formula: "max(usage.tools[].callCount)",
      sourceRefs: [],
    });
  }

  const distinctTools = usage.tools.length;
  if (distinctTools >= 8) {
    signals.push({
      id: "tool-breadth", family: "tooling",
      headline: `You reached for ${distinctTools} different tools`,
      detail: "A wide toolkit for one build window.",
      value: distinctTools, unit: "tools", notability: Math.min(100, distinctTools * 5),
      formula: "count(distinct usage.tools)",
      sourceRefs: [],
    });
  }

  const subagentTotal = inputs.sessions.reduce((sum, session) => sum + (session.subagentInvocations ?? 0), 0);
  if (subagentTotal > 0) {
    signals.push({
      id: "subagent-usage", family: "tooling",
      headline: `You delegated to subagents ${subagentTotal} time${subagentTotal === 1 ? "" : "s"}`,
      detail: "Work handed off to a subagent instead of handled directly.",
      value: subagentTotal, unit: "invocations", notability: Math.min(100, subagentTotal * 8),
      formula: "sum(session.subagentInvocations)",
      sourceRefs: [],
    });
  }

  return signals;
}

function conversationSignals(inputs: SignalInputs): Signal[] {
  const { sessions, usage } = inputs;
  const signals: Signal[] = [];
  if (sessions.length === 0) return signals;

  const busiest = sessions.reduce((best, session) => session.turns > best.turns ? session : best, sessions[0]!);
  const medianTurns = median(sessions.map((session) => session.turns));
  if (busiest.turns >= 10 && medianTurns > 0 && busiest.turns >= medianTurns * 2) {
    signals.push({
      id: "most-talkative-session", family: "conversation",
      headline: `Your most active session had ${busiest.turns} back-and-forth turns`,
      detail: `${round1(busiest.turns / medianTurns)}x your median session.`,
      value: busiest.turns, unit: "turns", notability: Math.min(100, Math.round((busiest.turns / medianTurns) * 15)),
      formula: "max(session.turns) vs median(session.turns)",
      sourceRefs: sourceRefFor(busiest.sessionRef, inputs.sources),
    });
  }

  const completed = sessions.filter((session) => session.status === "completed").length;
  const completionRate = pct(completed, sessions.length);
  if (sessions.length >= 3 && completionRate <= 60) {
    signals.push({
      id: "completion-rate", family: "conversation",
      headline: `${completionRate}% of your sessions ran to completion`,
      detail: `${sessions.length - completed} of ${sessions.length} sessions ended aborted, incomplete, or unresolved.`,
      value: completionRate, unit: "%", notability: Math.min(100, 100 - completionRate),
      formula: "round(100 * completedSessions / sessions)",
      sourceRefs: [],
    });
  }

  const planModeTurns = sessions.reduce((sum, session) => sum + (session.planModeTurns ?? 0), 0);
  const totalTurns = usage.totalTurns || sessions.reduce((sum, session) => sum + session.turns, 0);
  const planShare = pct(planModeTurns, totalTurns);
  if (planModeTurns > 0 && planShare >= 15) {
    signals.push({
      id: "plan-mode-discipline", family: "conversation",
      headline: `${planShare}% of your turns happened in plan mode`,
      detail: `${planModeTurns} of ${totalTurns} turns were spent planning before editing.`,
      value: planShare, unit: "%", notability: Math.min(100, Math.round(planShare * 1.2)),
      formula: "round(100 * planModeTurns / turns)",
      sourceRefs: [],
    });
  }

  return signals;
}

function spendSignals(inputs: SignalInputs): Signal[] {
  const { usage, sessions } = inputs;
  const signals: Signal[] = [];

  const tokenUsage = usage.tokenUsage;
  if (tokenUsage && tokenUsage.inputTokens > 0) {
    const cacheHitShare = pct(tokenUsage.cachedInputTokens, tokenUsage.inputTokens);
    if (cacheHitShare >= 20) {
      signals.push({
        id: "cache-hit-ratio", family: "spend",
        headline: `${cacheHitShare}% of your input tokens were served from cache`,
        detail: `${tokenUsage.cachedInputTokens.toLocaleString("en-US")} of ${tokenUsage.inputTokens.toLocaleString("en-US")} input tokens.`,
        value: cacheHitShare, unit: "%", notability: Math.min(100, Math.round(cacheHitShare * 1.1)),
        formula: "round(100 * cachedInputTokens / inputTokens)",
        sourceRefs: [],
      });
    }
  }
  if (tokenUsage && tokenUsage.totalTokens > 0 && tokenUsage.reasoningOutputTokens > 0) {
    const reasoningShare = pct(tokenUsage.reasoningOutputTokens, tokenUsage.totalTokens);
    if (reasoningShare >= 10) {
      signals.push({
        id: "reasoning-share", family: "spend",
        headline: `${reasoningShare}% of your tokens went to model reasoning`,
        detail: `${tokenUsage.reasoningOutputTokens.toLocaleString("en-US")} reasoning tokens out of ${tokenUsage.totalTokens.toLocaleString("en-US")} total.`,
        value: reasoningShare, unit: "%", notability: Math.min(100, Math.round(reasoningShare * 1.5)),
        formula: "round(100 * reasoningOutputTokens / totalTokens)",
        sourceRefs: [],
      });
    }
  }

  const withTokens = sessions.filter((session) => session.tokenUsage !== null);
  if (withTokens.length >= 2) {
    const heaviest = withTokens.reduce((best, session) => session.tokenUsage!.totalTokens > best.tokenUsage!.totalTokens ? session : best, withTokens[0]!);
    const medianTokens = median(withTokens.map((session) => session.tokenUsage!.totalTokens));
    if (medianTokens > 0 && heaviest.tokenUsage!.totalTokens >= medianTokens * 2) {
      signals.push({
        id: "token-heaviest-session", family: "spend",
        headline: `One session alone used ${heaviest.tokenUsage!.totalTokens.toLocaleString("en-US")} tokens`,
        detail: `${round1(heaviest.tokenUsage!.totalTokens / medianTokens)}x your median session's token usage.`,
        value: heaviest.tokenUsage!.totalTokens, unit: "tokens", notability: Math.min(100, Math.round((heaviest.tokenUsage!.totalTokens / medianTokens) * 12)),
        formula: "max(session.tokenUsage.totalTokens) vs median",
        sourceRefs: sourceRefFor(heaviest.sessionRef, inputs.sources),
      });
    }
  }

  return signals;
}

function outputSignals(inputs: SignalInputs): Signal[] {
  const { git } = inputs;
  const signals: Signal[] = [];
  if (git.commits === 0) return signals;

  const linesPerCommit = Math.round((git.insertions + git.deletions) / git.commits);
  if (linesPerCommit >= 50) {
    signals.push({
      id: "lines-per-commit", family: "output",
      headline: `You averaged ${linesPerCommit} changed lines per commit`,
      detail: `${git.insertions.toLocaleString("en-US")} insertions and ${git.deletions.toLocaleString("en-US")} deletions across ${git.commits} commits.`,
      value: linesPerCommit, unit: "lines", notability: Math.min(100, Math.round(linesPerCommit / 3)),
      formula: "round((insertions + deletions) / commits)",
      sourceRefs: [],
    });
  }

  const mergeShare = pct(git.mergeCommits, git.commits);
  if (git.mergeCommits > 0 && mergeShare >= 10) {
    signals.push({
      id: "merge-ratio", family: "output",
      headline: `${mergeShare}% of your commits were merges`,
      detail: `${git.mergeCommits} of ${git.commits} commits.`,
      value: mergeShare, unit: "%", notability: Math.min(100, mergeShare),
      formula: "round(100 * mergeCommits / commits)",
      sourceRefs: [],
    });
  }

  return signals;
}

function evidenceSignals(bundle: NarrativeEvidenceBundle | undefined): Signal[] {
  if (!bundle) return [];
  const kept = bundle.excerpts.length;
  const seen = bundle.discarded.candidates;
  if (seen <= kept) return [];
  const trimmedShare = pct(seen - kept, seen);
  return [{
    id: "evidence-selectivity", family: "evidence",
    headline: `Buildstory reviewed ${seen} moments and kept ${kept} for this story`,
    detail: `${bundle.discarded.rejectedByBudget} were trimmed by the evidence budget${bundle.discarded.rejectedByRedaction ? `, ${bundle.discarded.rejectedByRedaction} by redaction` : ""}.`,
    value: kept, unit: "excerpts", notability: Math.min(100, trimmedShare),
    formula: "discarded.candidates vs excerpts kept",
    sourceRefs: [],
  }];
}

/**
 * Computes every deterministic, publishable fact that clears its family's
 * floor, sorted by notability desc (ties broken by id for a stable order).
 * Purely a function of the inputs - no model call, no randomness, so the
 * same snapshot always produces the same signals in the same order. Runs
 * for every narrative mode including "off": signals need no key and no
 * network, so a facts-only report costs nothing to produce.
 */
export function computeSignals(inputs: SignalInputs): Signal[] {
  const signals = [
    ...rhythmSignals(inputs),
    ...toolingSignals(inputs),
    ...conversationSignals(inputs),
    ...spendSignals(inputs),
    ...outputSignals(inputs),
    ...evidenceSignals(inputs.narrativeEvidence),
  ];
  return signals.sort((left, right) => right.notability - left.notability || left.id.localeCompare(right.id));
}
