import type { GitAggregateMetrics, SessionSummary, TimeWindow, UsageSummary } from "../contract.js";

export const PROFILE_DIMENSIONS = [
  "planning",
  "steering",
  "execution",
  "engineering",
  "productInstinct",
] as const;

export type ProfileDimension = typeof PROFILE_DIMENSIONS[number];
export const ARCHETYPES = [
  "Night Owl",
  "Early Bird",
  "Weekend Warrior",
  "Marathon Coder",
  "Architect",
  "Quality Guardian",
  "Shipping Machine",
  "Explorer",
] as const;
export type ComputedArchetype = (typeof ARCHETYPES)[number];
/** Legacy snapshots may still store Velocity Machine; new scans emit Shipping Machine. */
export type Archetype = ComputedArchetype | "Velocity Machine";

export function canonicalArchetypeName(name: string): ComputedArchetype | string {
  if (name === "Velocity Machine") return "Shipping Machine";
  return name;
}

export function archetypeFacetKey(name: string): string {
  return canonicalArchetypeName(name).toLocaleLowerCase("en-US").replaceAll(" ", "-");
}

export type ProfileScore = {
  value: number;
  rawInputs: Record<string, number>;
  formula: string;
  caveat?: string;
};

export type BuilderProfile = {
  scores: Record<ProfileDimension, ProfileScore>;
  archetype: {
    name: Archetype;
    rationale: string[];
  };
  workPatterns: {
    peakHours: number[];
    preferredDays: string[];
    medianSessionMinutes: number;
    longestSessionMinutes: number;
    primaryModel: string | null;
    timezoneLabel: string;
    nightShare: number;
    morningShare: number;
    weekendShare: number;
    distinctToolCount: number;
  };
};

export type ProfileInputs = {
  sessions: SessionSummary[];
  usage: UsageSummary;
  git: GitAggregateMetrics;
  timeWindow?: Pick<TimeWindow, "utcOffsetMinutes">;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4]);
const MORNING_HOURS = new Set([5, 6, 7, 8, 9]);
const WEEKEND_DAYS = new Set(["Saturday", "Sunday"]);
const VERIFICATION_TOOLS = new Set(["Test", "Tests", "Run", "Shell", "Terminal", "Bash", "Check", "Lint", "Build", "Review"]);
const EXPLORATORY_TOOLS = new Set(["Read", "Grep", "Glob", "Search", "Find", "List"]);
const MUTATING_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "Create", "Delete", "Move"]);

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sharePercent(count: number, total: number): number {
  return total > 0 ? Math.round((count * 100) / total) : 0;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function toolFamily(name: string): "exploratory" | "mutating" | "verification" | "other" {
  const normalized = name.trim().toLocaleLowerCase("en-US");
  if ([...EXPLORATORY_TOOLS].some((item) => normalized === item.toLocaleLowerCase("en-US") || normalized.includes(item.toLocaleLowerCase("en-US")))) return "exploratory";
  if ([...MUTATING_TOOLS].some((item) => normalized === item.toLocaleLowerCase("en-US") || normalized.includes(item.toLocaleLowerCase("en-US")))) return "mutating";
  if ([...VERIFICATION_TOOLS].some((item) => normalized === item.toLocaleLowerCase("en-US") || normalized.includes(item.toLocaleLowerCase("en-US")))) return "verification";
  return "other";
}

function durationMinutes(session: SessionSummary): number {
  const duration = Date.parse(session.endedAt) - Date.parse(session.startedAt);
  return Math.max(0, Math.round(duration / 60_000));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

function localHour(timestamp: string, utcOffsetMinutes: number): number {
  const utcMillis = Date.parse(timestamp);
  if (!Number.isFinite(utcMillis)) return 0;
  const shifted = new Date(utcMillis + utcOffsetMinutes * 60_000);
  return shifted.getUTCHours();
}

function localDay(timestamp: string, utcOffsetMinutes: number): string {
  const utcMillis = Date.parse(timestamp);
  if (!Number.isFinite(utcMillis)) return DAY_NAMES[0]!;
  const shifted = new Date(utcMillis + utcOffsetMinutes * 60_000);
  return DAY_NAMES[shifted.getUTCDay()]!;
}

function timezoneLabel(offset: number | undefined): string {
  if (offset === undefined || offset === 0) return "UTC";
  const sign = offset > 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function countTools(usage: UsageSummary, predicate: (name: string) => boolean): number {
  return usage.tools
    .filter((tool) => predicate(tool.name))
    .reduce((sum, tool) => sum + tool.callCount, 0);
}

function scoreProfile(inputs: ProfileInputs): BuilderProfile["scores"] {
  const { sessions, usage, git } = inputs;
  const turns = usage.totalTurns || sessions.reduce((sum, session) => sum + session.turns, 0);
  const planModeTurns = sessions.reduce((sum, session) => sum + (session.planModeTurns ?? 0), 0);
  const exploratoryCalls = countTools(usage, (name) => toolFamily(name) === "exploratory");
  const mutatingCalls = countTools(usage, (name) => toolFamily(name) === "mutating");
  const exploratoryMutatingTotal = exploratoryCalls + mutatingCalls;
  const planRatio = safeRatio(planModeTurns, turns);
  const exploratoryRatio = safeRatio(exploratoryCalls, exploratoryMutatingTotal);
  const planning = clampPercent((planRatio * 0.6 + exploratoryRatio * 0.4) * 100);

  const assistantMessages = sessions.reduce((sum, session) => sum + session.assistantMessages, 0);
  const userTurnsPerAssistant = safeRatio(turns, assistantMessages);
  const steering = clampPercent(Math.min(1, userTurnsPerAssistant / 3) * 100);

  const activeDays = new Set(sessions.map((session) => session.startedAt.slice(0, 10))).size;
  const sessionCount = sessions.length;
  const commitsPerActiveDay = safeRatio(git.commits, Math.max(activeDays, 1));
  const insertionsPerActiveDay = safeRatio(git.insertions, Math.max(activeDays, 1));
  const toolCallsPerSession = safeRatio(usage.totalToolCalls, Math.max(sessionCount, 1));
  const execution = clampPercent(
    (Math.min(1, commitsPerActiveDay / 5) * 0.4 +
      Math.min(1, insertionsPerActiveDay / 1_000) * 0.3 +
      Math.min(1, toolCallsPerSession / 50) * 0.3) * 100,
  );

  const distinctToolRefs = new Set(sessions.flatMap((session) => session.toolRefs)).size;
  const verificationCalls = countTools(usage, (name) => toolFamily(name) === "verification");
  const subagentInvocations = sessions.reduce((sum, session) => sum + (session.subagentInvocations ?? 0), 0);
  const engineering = clampPercent(
    (Math.min(1, distinctToolRefs / 12) * 0.4 +
      safeRatio(verificationCalls, Math.max(usage.totalToolCalls, 1)) * 0.4 +
      Math.min(1, safeRatio(subagentInvocations, Math.max(sessionCount, 1)) / 3) * 0.2) * 100,
  );

  const completedSessions = sessions.filter((session) => session.status === "completed").length;
  const completionRate = safeRatio(completedSessions, sessionCount);
  const productInstinct = clampPercent(completionRate * planRatio * 100);

  return {
    planning: {
      value: planning,
      rawInputs: { planModeTurns, turns, planRatio, exploratoryCalls, mutatingCalls, exploratoryRatio },
      formula: "round(100 * (0.60 * planModeTurns/turns + 0.40 * exploratoryCalls/(exploratoryCalls+mutatingCalls)))",
    },
    steering: {
      value: steering,
      rawInputs: { turns, assistantMessages, userTurnsPerAssistant },
      formula: "round(100 * min(1, (turns/assistantMessages)/3))",
    },
    execution: {
      value: execution,
      rawInputs: { commits: git.commits, insertions: git.insertions, activeDays, toolCalls: usage.totalToolCalls, sessions: sessionCount, commitsPerActiveDay, insertionsPerActiveDay, toolCallsPerSession },
      formula: "round(100 * (0.40*min(1, commitsPerActiveDay/5) + 0.30*min(1, insertionsPerActiveDay/1000) + 0.30*min(1, toolCallsPerSession/50)))",
    },
    engineering: {
      value: engineering,
      rawInputs: { distinctToolRefs, verificationCalls, totalToolCalls: usage.totalToolCalls, subagentInvocations, sessions: sessionCount },
      formula: "round(100 * (0.40*min(1, distinctToolRefs/12) + 0.40*verificationCalls/totalToolCalls + 0.20*min(1, subagents/sessions/3)))",
    },
    productInstinct: {
      value: productInstinct,
      rawInputs: { completedSessions, sessions: sessionCount, completionRate, planModeTurns, turns, planRatio },
      formula: "round(100 * completionRate * planModeTurns/turns)",
      caveat: "Weak proxy: completion plus plan-before-edit signals are not a direct measure of product judgment.",
    },
  };
}

function archetypeFor(scores: BuilderProfile["scores"], workPatterns: BuilderProfile["workPatterns"]): BuilderProfile["archetype"] {
  type Candidate = { name: ComputedArchetype; score: number; rationale: string };
  const candidates: Candidate[] = [];
  if (workPatterns.nightShare >= 20) {
    candidates.push({
      name: "Night Owl",
      score: workPatterns.nightShare,
      rationale: `${workPatterns.nightShare}% of sessions started between 10pm and 5am ${workPatterns.timezoneLabel}.`,
    });
  }
  if (workPatterns.morningShare >= 20) {
    candidates.push({
      name: "Early Bird",
      score: workPatterns.morningShare,
      rationale: `${workPatterns.morningShare}% of sessions started between 5am and 10am ${workPatterns.timezoneLabel}.`,
    });
  }
  if (workPatterns.weekendShare >= 30) {
    candidates.push({
      name: "Weekend Warrior",
      score: workPatterns.weekendShare,
      rationale: `${workPatterns.weekendShare}% of sessions landed on a weekend.`,
    });
  }
  const median = workPatterns.medianSessionMinutes;
  const longest = workPatterns.longestSessionMinutes;
  if (median > 0 && longest >= 60 && longest >= median * 2) {
    const ratio = Math.round((longest / median) * 10) / 10;
    candidates.push({
      name: "Marathon Coder",
      score: Math.min(100, Math.round(ratio * 20)),
      rationale: `Longest session ran ${longest} minutes — ${ratio}× the median.`,
    });
  }
  if (scores.planning.value >= 70 && scores.engineering.value >= 60) {
    candidates.push({
      name: "Architect",
      score: Math.round((scores.planning.value + scores.engineering.value) / 2),
      rationale: `Planning scored ${scores.planning.value} and engineering scored ${scores.engineering.value}.`,
    });
  }
  if (scores.engineering.value >= 70 && scores.planning.value >= 55) {
    candidates.push({
      name: "Quality Guardian",
      score: scores.engineering.value,
      rationale: `Engineering scored ${scores.engineering.value} with planning at ${scores.planning.value}.`,
    });
  }
  if (workPatterns.distinctToolCount >= 8) {
    candidates.push({
      name: "Explorer",
      score: Math.min(100, workPatterns.distinctToolCount * 8),
      rationale: `Reached for ${workPatterns.distinctToolCount} different tools in this window.`,
    });
  }
  if (candidates.length === 0) {
    return {
      name: "Shipping Machine",
      rationale: [`Execution scored ${scores.execution.value}; it was the clearest delivery signal in this window.`],
    };
  }
  candidates.sort((left, right) => right.score - left.score || ARCHETYPES.indexOf(left.name) - ARCHETYPES.indexOf(right.name));
  const winner = candidates[0]!;
  return { name: winner.name, rationale: [winner.rationale] };
}

export function computeBuilderProfile(inputs: ProfileInputs): BuilderProfile {
  const offset = inputs.timeWindow?.utcOffsetMinutes ?? 0;
  const durations = inputs.sessions.map(durationMinutes);
  const hourCounts = new Map<number, number>();
  const dayCounts = new Map<string, number>();
  let nightCount = 0;
  let morningCount = 0;
  let weekendCount = 0;
  for (const session of inputs.sessions) {
    const hour = localHour(session.startedAt, offset);
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1);
    const day = localDay(session.startedAt, offset);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    if (NIGHT_HOURS.has(hour)) nightCount += 1;
    if (MORNING_HOURS.has(hour)) morningCount += 1;
    if (WEEKEND_DAYS.has(day)) weekendCount += 1;
  }
  const peakHours = [...hourCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, 3)
    .map(([hour]) => hour);
  const preferredDays = [...dayCounts.entries()]
    .sort((left, right) => right[1] - left[1] || DAY_NAMES.indexOf(left[0]) - DAY_NAMES.indexOf(right[0]))
    .slice(0, 3)
    .map(([day]) => day);
  const primaryModel = [...inputs.usage.models]
    .sort((left, right) => right.turnCount - left.turnCount || `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`))[0];
  const sessionCount = inputs.sessions.length;
  const workPatterns: BuilderProfile["workPatterns"] = {
    peakHours,
    preferredDays,
    medianSessionMinutes: median(durations),
    longestSessionMinutes: durations.length ? Math.max(...durations) : 0,
    primaryModel: primaryModel ? `${primaryModel.provider}:${primaryModel.name}` : null,
    timezoneLabel: timezoneLabel(inputs.timeWindow?.utcOffsetMinutes),
    nightShare: sharePercent(nightCount, sessionCount),
    morningShare: sharePercent(morningCount, sessionCount),
    weekendShare: sharePercent(weekendCount, sessionCount),
    distinctToolCount: inputs.usage.tools.length,
  };
  const scores = scoreProfile(inputs);
  return { scores, archetype: archetypeFor(scores, workPatterns), workPatterns };
}

export type ProfileNarrativeSections = {
  headline: string;
  narrative: string;
  turningPoint: string;
  learnings: string[];
  decisionPatterns: string[];
  standoutTraits: string[];
  growthEdge: string;
};

export function defaultProfileNarrative(profile: BuilderProfile): { sections: ProfileNarrativeSections; fallbacksUsed: string[] } {
  const topScores = PROFILE_DIMENSIONS
    .map((dimension) => `${dimension} ${profile.scores[dimension].value}`)
    .join(", ");
  const primaryModel = profile.workPatterns.primaryModel ?? "no primary model recorded";
  const peak = profile.workPatterns.peakHours.length
    ? profile.workPatterns.peakHours.map((hour) => `${String(hour).padStart(2, "0")}:00`).join(", ")
    : "no recurring peak hour";
  return {
    sections: {
      headline: `${profile.archetype.name}: a builder profile`,
      narrative: `The measured profile reads as ${profile.archetype.name}. The strongest observed signals are ${topScores}. This is a metrics-backed pattern, not a personality diagnosis; the qualitative story depends on the source excerpts when they are available.`,
      turningPoint: `The clearest measured pattern is ${profile.archetype.rationale[0] ?? "the balance between planning, steering, and execution"}`,
      learnings: [
        `Primary model: ${primaryModel}.`,
        `Most active hours: ${peak} ${profile.workPatterns.timezoneLabel}.`,
        `Median session length: ${profile.workPatterns.medianSessionMinutes} minutes.`,
      ],
      decisionPatterns: ["Plans, exploratory work, and delivery activity were compared as aggregate signals rather than inferred intent."],
      standoutTraits: [
        `${profile.archetype.name} is the closest rule-based archetype for this scan window.`,
        `The strongest score signal is ${PROFILE_DIMENSIONS.reduce((best, dimension) => profile.scores[dimension].value > profile.scores[best].value ? dimension : best, PROFILE_DIMENSIONS[0])}.`,
      ],
      growthEdge: "Use this profile as a prompt for reflection, not as a verdict; the product-instinct score is especially provisional.",
    },
    fallbacksUsed: ["headline", "narrative", "turningPoint", "learnings", "decisionPatterns", "standoutTraits", "growthEdge"],
  };
}
