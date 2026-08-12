import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import type { EvidenceReference, Milestone, SessionSummary } from "../src/contract.js";
import { buildEventSpine } from "../src/insights/event-spine.js";

const session: SessionSummary = {
  sessionRef: "ses_11111111111111111111",
  provider: "codex",
  sourceKind: "active",
  startedAt: "2026-08-01T10:00:00.000Z",
  endedAt: "2026-08-01T11:00:00.000Z",
  status: "completed",
  workingDirectoryRelation: "repository-root",
  summary: "Codex session with 8 user turns, 9 assistant messages, and 12 tool calls.",
  turns: 8,
  assistantMessages: 9,
  toolCalls: 12,
  modelRefs: ["model-a", "model-b"],
  toolRefs: ["read", "apply_patch", "test"],
  tokenUsage: null,
  planModeTurns: 2,
  subagentInvocations: 1,
};
const evidence: EvidenceReference[] = [{
  evidenceId: "ev_22222222222222222222",
  source: "codex",
  kind: "session-boundary",
  observedAt: session.startedAt,
  digest: `sha256:${"3".repeat(64)}`,
  sessionRef: session.sessionRef,
}];
const milestones: Milestone[] = [{
  milestoneId: "mil_44444444444444444444",
  kind: "session-activity",
  title: "Codex session activity",
  summary: session.summary,
  occurredAt: session.endedAt,
  evidenceRefs: [evidence[0]!.evidenceId],
}];

test("event spine is deterministic, chronological, and content-free", () => {
  const input = { generatedAt: session.endedAt, sessions: [session], milestones, evidence };
  const first = buildEventSpine(input);
  const second = buildEventSpine(input);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.deepEqual(first.events.map((event) => event.kind), [
    "session-start", "planning", "model-shift", "exploration", "mutation", "verification", "delegation", "session-outcome",
  ]);
  assert.ok(first.events.every((event) => event.sourceRefs[0] === evidence[0]!.evidenceId));
  assert.equal(first.events.find((event) => event.kind === "verification")?.measurement, "distinct-tools");
  assert.equal(first.events.find((event) => event.kind === "verification")?.temporalPrecision, "estimated");
  const serialized = canonicalJson(first);
  for (const forbidden of ["prompt", "diff", "toolPayload", "filePath", "https://"]) assert.equal(serialized.includes(forbidden), false);
});
