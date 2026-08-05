import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareStrings, sha256, shortHash } from "../canonical-json.js";
import type {
  EvidenceReference,
  NarrativeExcerpt,
  QualityWarning,
  SessionStatus,
  SessionSummary,
  TokenUsage,
} from "../contract.js";
import type { Redactor } from "../redaction.js";
import { consumeJsonLines } from "./jsonl.js";
import { relationToRepository } from "./path-scope.js";
import type {
  ExcerptExtractionResult,
  ProviderDiscoveryContext,
  ProviderDiscoveryResult,
  ProviderSession,
  SessionProviderAdapter,
} from "./types.js";

const MAX_PROJECT_DIRECTORIES = 2_000;
const MAX_SESSION_FILES = 5_000;
const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SUBAGENT_FILES_PER_SESSION = 200;
const MAX_DISCOVERY_LINES = 50;

type JsonRecord = Record<string, unknown>;
type SourceKind = SessionSummary["sourceKind"];

interface LocatedSessionFile {
  filePath: string;
  kind: SourceKind;
}

interface EventMarker {
  ordinal: number;
  timestamp: string;
}

interface ParseResult {
  matched: boolean;
  session?: ProviderSession;
  warnings: QualityWarning[];
  skipped: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function addCount(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function warning(
  code: QualityWarning["code"],
  severity: QualityWarning["severity"],
  message: string,
  sessionRef?: string,
): QualityWarning {
  return sessionRef === undefined ? { code, severity, message } : { code, severity, message, sessionRef };
}

/**
 * Claude Code writes `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`,
 * encoding the working directory by replacing every run of non
 * alphanumeric characters with a single "-". That encoding is lossy and
 * case-sensitive project directories are common (the same repository
 * scanned from two differently-cased paths produces two directories), so it
 * is used only as a cheap, case-insensitive prefix filter over candidate
 * directories here. The `cwd` recorded on each transcript line is the only
 * value ever used to decide repository scope.
 */
function encodedDirectoryPrefix(repositoryRoot: string): string {
  const normalized = path.resolve(repositoryRoot);
  return normalized.replaceAll(/[^A-Za-z0-9]+/g, "-").toLocaleLowerCase("en-US");
}

async function discoverProjectDirectories(root: string, prefix: string): Promise<{ dirs: string[]; available: boolean }> {
  let entries;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { dirs: [], available: false };
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { dirs: [], available: false };
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => name.toLocaleLowerCase("en-US").startsWith(prefix))
    .sort(compareStrings)
    .slice(0, MAX_PROJECT_DIRECTORIES)
    .map((name) => path.join(root, name));
  return { dirs, available: true };
}

async function discoverSessionFiles(projectDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLocaleLowerCase("en-US").endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort(compareStrings)
    .map((name) => path.join(projectDir, name));
}

/** Sibling `<session-uuid>/subagents/agent-*.jsonl` files, if the install writes them. */
async function discoverSubagentFiles(mainFilePath: string): Promise<string[]> {
  const sessionDir = mainFilePath.slice(0, mainFilePath.length - path.extname(mainFilePath).length);
  const subagentsDir = path.join(sessionDir, "subagents");
  let entries;
  try {
    const stat = await lstat(subagentsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLocaleLowerCase("en-US").endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort(compareStrings)
    .slice(0, MAX_SUBAGENT_FILES_PER_SESSION)
    .map((name) => path.join(subagentsDir, name));
}

async function subagentAgentType(subagentFilePath: string): Promise<string | null> {
  const metaPath = `${subagentFilePath.slice(0, -".jsonl".length)}.meta.json`;
  try {
    const stat = await lstat(metaPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const { readFile } = await import("node:fs/promises");
    const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    const record = asRecord(parsed);
    return record ? asString(record.agentType) : null;
  } catch {
    return null;
  }
}

function parseTokenUsage(usage: JsonRecord | null): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = asNonNegativeInteger(usage.input_tokens);
  const outputTokens = asNonNegativeInteger(usage.output_tokens);
  const cacheCreationInputTokens = asNonNegativeInteger(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = asNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreation = asRecord(usage.cache_creation);
  const cacheCreation1hInputTokens = asNonNegativeInteger(cacheCreation?.ephemeral_1h_input_tokens);
  const cacheCreation5mInputTokens = asNonNegativeInteger(cacheCreation?.ephemeral_5m_input_tokens);
  return {
    inputTokens,
    // Anthropic's cache-read tokens are a separate billed bucket, not a
    // subset of inputTokens the way OpenAI's cached_input_tokens is; that
    // distinct accounting lives in cacheReadInputTokens below. This legacy
    // field has no Claude Code equivalent, so it is honestly zero rather
    // than double-counting cache reads under a mismatched semantic.
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheCreation1hInputTokens,
    cacheCreation5mInputTokens,
    cacheReadInputTokens,
  };
}

function addTokenUsage(total: TokenUsage | null, addition: TokenUsage | null): TokenUsage | null {
  if (!addition) return total;
  if (!total) return addition;
  return {
    inputTokens: total.inputTokens + addition.inputTokens,
    cachedInputTokens: total.cachedInputTokens + addition.cachedInputTokens,
    outputTokens: total.outputTokens + addition.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + addition.reasoningOutputTokens,
    totalTokens: total.totalTokens + addition.totalTokens,
    cacheCreationInputTokens: (total.cacheCreationInputTokens ?? 0) + (addition.cacheCreationInputTokens ?? 0),
    cacheCreation1hInputTokens: (total.cacheCreation1hInputTokens ?? 0) + (addition.cacheCreation1hInputTokens ?? 0),
    cacheCreation5mInputTokens: (total.cacheCreation5mInputTokens ?? 0) + (addition.cacheCreation5mInputTokens ?? 0),
    cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + (addition.cacheReadInputTokens ?? 0),
  };
}

/** True for a `user` record that is a tool-result continuation rather than genuine authored input. */
function isToolResultContinuation(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => isRecord(block) && block.type === "tool_result");
}

/** Sums assistant-message token usage and tool names from one transcript file (main or subagent). */
async function parseUsageAndTools(
  filePath: string,
): Promise<{ usage: TokenUsage | null; toolCounts: Map<string, number>; modelCounts: Map<string, { provider: string; turns: number }> }> {
  let usage: TokenUsage | null = null;
  const toolCounts = new Map<string, number>();
  const modelCounts = new Map<string, { provider: string; turns: number }>();
  await consumeJsonLines(filePath, (line) => {
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (!isRecord(parsed)) return true;
      record = parsed;
    } catch {
      return true;
    }
    if (record.type !== "assistant" || record.isSidechain === true) return true;
    const message = asRecord(record.message);
    if (!message) return true;
    usage = addTokenUsage(usage, parseTokenUsage(asRecord(message.usage)));
    const model = asString(message.model);
    if (model) {
      const existing = modelCounts.get(model);
      modelCounts.set(model, { provider: "anthropic", turns: (existing?.turns ?? 0) + 1 });
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (isRecord(block) && block.type === "tool_use") {
        const name = asString(block.name) ?? "unknown-tool";
        addCount(toolCounts, name);
      }
    }
    return true;
  });
  return { usage, toolCounts, modelCounts };
}

async function parseClaudeCodeFile(
  located: LocatedSessionFile,
  context: ProviderDiscoveryContext,
): Promise<ParseResult> {
  const warnings: QualityWarning[] = [];
  let stat;
  try {
    stat = await lstat(located.filePath);
  } catch {
    return { matched: false, skipped: true, warnings };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { matched: false, skipped: true, warnings };
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    warnings.push(warning("SESSION_FILE_TOO_LARGE", "warning", "A Claude Code session exceeded the 128 MiB safety limit and was skipped."));
    return { matched: false, skipped: true, warnings };
  }

  let scope: SessionSummary["workingDirectoryRelation"] | null | undefined;
  let rawSessionId: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let firstMarker: EventMarker | null = null;
  let lastMarker: EventMarker | null = null;
  let firstToolMarker: EventMarker | null = null;
  let invalidJson = false;
  let invalidTimestamp = false;
  let turns = 0;
  let planModeTurns = 0;
  let assistantMessages = 0;
  let lastAssistantStopReason: string | null = null;
  let tokenUsage: TokenUsage | null = null;
  const toolCounts = new Map<string, number>();
  const modelCounts = new Map<string, { provider: string; turns: number }>();

  const result = await consumeJsonLines(located.filePath, (line, ordinal) => {
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (!isRecord(parsed)) throw new TypeError("not an object");
      record = parsed;
    } catch {
      invalidJson = true;
      return scope !== undefined || ordinal < MAX_DISCOVERY_LINES;
    }

    const timestamp = isoTimestamp(record.timestamp);
    if (record.timestamp !== undefined && timestamp === null) invalidTimestamp = true;
    if (timestamp) {
      if (firstTimestamp === null || timestamp < firstTimestamp) {
        firstTimestamp = timestamp;
        firstMarker = { ordinal, timestamp };
      }
      if (lastTimestamp === null || timestamp > lastTimestamp) {
        lastTimestamp = timestamp;
        lastMarker = { ordinal, timestamp };
      }
    }

    if (rawSessionId === null) rawSessionId = asString(record.sessionId);
    if (scope === undefined) {
      const cwd = asString(record.cwd);
      if (cwd) scope = relationToRepository(context.repositoryRoot, cwd);
    }
    if (scope === null) return false;
    if (scope === undefined && ordinal >= MAX_DISCOVERY_LINES) return false;
    if (scope === undefined) return true;

    const recordType = asString(record.type);
    if (record.isSidechain === true) return true; // inline subagent content, if an install ever emits it

    if (recordType === "user") {
      const message = asRecord(record.message);
      const content = message?.content;
      if (!isToolResultContinuation(content)) {
        turns += 1;
        if (asString(record.permissionMode) === "plan") planModeTurns += 1;
      }
    } else if (recordType === "assistant") {
      const message = asRecord(record.message);
      if (message) {
        const content = Array.isArray(message.content) ? message.content : [];
        const hasText = content.some((block) => isRecord(block) && block.type === "text");
        if (hasText) assistantMessages += 1;
        lastAssistantStopReason = asString(message.stop_reason);
        tokenUsage = addTokenUsage(tokenUsage, parseTokenUsage(asRecord(message.usage)));
        const rawModel = asString(message.model);
        if (rawModel) {
          const model = context.redactor.cleanMetadata(rawModel, 160);
          const existing = modelCounts.get(model);
          modelCounts.set(model, { provider: "anthropic", turns: (existing?.turns ?? 0) + 1 });
        } else {
          warnings.push(warning("SESSION_MODEL_UNKNOWN", "info", "No model identifier was present in an assistant message."));
        }
        for (const block of content) {
          if (isRecord(block) && block.type === "tool_use") {
            const rawToolName = asString(block.name) ?? "unknown-tool";
            const toolName = context.redactor.cleanMetadata(rawToolName, 160);
            addCount(toolCounts, toolName);
            if (timestamp && firstToolMarker === null) firstToolMarker = { ordinal, timestamp };
          }
        }
      }
    }
    context.redactor.recordTranscriptBodyDiscarded();
    return true;
  });

  if (scope !== "repository-root" && scope !== "subdirectory") {
    if (rawSessionId === null && firstTimestamp === null) {
      warnings.push(warning("SESSION_MISSING_METADATA", "info", "A Claude Code transcript had no repository-scoping metadata in its discovery prefix."));
    }
    return { matched: false, skipped: false, warnings };
  }

  const fallbackIdentity = `${located.kind}:${path.basename(located.filePath)}`;
  const sessionRef = `ses_${shortHash(`claude-code\0${context.repositoryFingerprint}\0${rawSessionId ?? fallbackIdentity}`, 20)}`;
  if (invalidJson) {
    warnings.push(warning("SESSION_LINE_INVALID_JSON", "warning", "At least one JSONL record was invalid and ignored.", sessionRef));
  }
  if (result.oversizedLines > 0) {
    warnings.push(warning("SESSION_LINE_TOO_LARGE", "warning", "At least one JSONL record exceeded the 4 MiB safety limit and was ignored.", sessionRef));
  }
  if (invalidTimestamp) {
    warnings.push(warning("SESSION_TIMESTAMP_INVALID", "warning", "At least one session timestamp was invalid and ignored.", sessionRef));
  }
  const startMarker = firstMarker as EventMarker | null;
  const endMarker = lastMarker as EventMarker | null;
  let toolMarker = firstToolMarker as EventMarker | null;
  if (!firstTimestamp || !lastTimestamp || !startMarker || !endMarker) {
    warnings.push(warning("SESSION_TIMESTAMP_INVALID", "warning", "A matched session had no usable timestamp and was excluded.", sessionRef));
    return { matched: true, skipped: true, warnings };
  }

  if (modelCounts.size === 0) {
    warnings.push(warning("SESSION_MODEL_UNKNOWN", "info", "No model identifier was present in the session metadata.", sessionRef));
  }
  const status: SessionStatus =
    lastAssistantStopReason === null ? "unknown" : lastAssistantStopReason === "tool_use" ? "incomplete" : "completed";
  if (status === "incomplete" && located.kind === "active") {
    warnings.push(warning("SESSION_ACTIVE_AT_SCAN_END", "info", "An active Claude Code session had no completion marker at the observed boundary.", sessionRef));
  }

  // toolCalls counts real tool_use invocations in the main transcript only.
  // A subagent spawn is itself already one such tool_use block, so the
  // informational "Agent:<type>" / "<tool> (subagent)" entries added below
  // must not inflate this count a second time.
  const toolCalls = [...toolCounts.values()].reduce((sum, count) => sum + count, 0);

  let subagentInvocations = 0;
  for (const subagentFile of await discoverSubagentFiles(located.filePath)) {
    const subagentResult = await parseUsageAndTools(subagentFile);
    tokenUsage = addTokenUsage(tokenUsage, subagentResult.usage);
    subagentInvocations += 1;
    const agentType = await subagentAgentType(subagentFile);
    addCount(toolCounts, `Agent:${context.redactor.cleanMetadata(agentType ?? "unknown", 80)}`);
    for (const [name, count] of subagentResult.toolCounts) addCount(toolCounts, `${name} (subagent)`, count);
  }
  const summaryText = context.redactor.cleanMetadata(
    `Claude Code session with ${turns} user turn${turns === 1 ? "" : "s"}, ${assistantMessages} assistant message${assistantMessages === 1 ? "" : "s"}, and ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}.`,
    240,
  );

  const evidence: EvidenceReference[] = [];
  const addEvidence = (kind: EvidenceReference["kind"], marker: EventMarker): void => {
    const seed = `${sessionRef}\0${kind}\0${marker.ordinal}\0${marker.timestamp}`;
    evidence.push({
      evidenceId: `ev_${shortHash(seed, 20)}`,
      source: "claude-code",
      kind,
      observedAt: marker.timestamp,
      digest: sha256(seed),
      sessionRef,
      eventOrdinal: marker.ordinal,
    });
  };
  addEvidence("session-boundary", startMarker);
  if (endMarker.ordinal !== startMarker.ordinal) addEvidence("session-boundary", endMarker);
  if (toolMarker) addEvidence("tool-activity", toolMarker);

  return {
    matched: true,
    skipped: false,
    warnings,
    session: {
      summary: {
        sessionRef,
        provider: "claude-code",
        sourceKind: located.kind,
        startedAt: firstTimestamp,
        endedAt: lastTimestamp,
        status,
        workingDirectoryRelation: scope,
        summary: summaryText,
        turns,
        assistantMessages,
        toolCalls,
        modelRefs: [...modelCounts.keys()].sort(compareStrings),
        toolRefs: [...toolCounts.keys()].sort(compareStrings),
        tokenUsage,
        ...(turns > 0 ? { planModeTurns } : {}),
        ...(subagentInvocations > 0 ? { subagentInvocations } : {}),
      },
      toolCounts,
      modelCounts,
      evidence: evidence.sort((left, right) => compareStrings(left.evidenceId, right.evidenceId)),
      sourceFilePath: located.filePath,
    },
  };
}

export interface ClaudeCodeAdapterOptions {
  claudeCodeHome?: string;
}

export class ClaudeCodeSessionAdapter implements SessionProviderAdapter {
  public readonly provider = "claude-code" as const;
  public readonly sessionFormat = "claude-code-jsonl" as const;
  private readonly projectsRoot: string;
  private readonly kind: SourceKind;

  public constructor(options: ClaudeCodeAdapterOptions = {}) {
    const configuredHome = options.claudeCodeHome ?? process.env.CLAUDE_CONFIG_DIR;
    this.projectsRoot = configuredHome
      ? path.join(configuredHome, "projects")
      : path.join(os.homedir(), ".claude", "projects");
    this.kind = options.claudeCodeHome ? "custom" : "active";
  }

  public async discover(context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult> {
    const warnings: QualityWarning[] = [];
    const prefix = encodedDirectoryPrefix(context.repositoryRoot);
    const { dirs, available } = await discoverProjectDirectories(this.projectsRoot, prefix);
    if (!available) {
      warnings.push(warning("CLAUDE_CODE_ROOT_UNAVAILABLE", "info", "The configured Claude Code session root was unavailable and was skipped."));
    }

    const locatedFiles: LocatedSessionFile[] = [];
    for (const dir of dirs) {
      for (const filePath of await discoverSessionFiles(dir)) {
        locatedFiles.push({ filePath, kind: this.kind });
      }
    }
    locatedFiles.sort((left, right) => compareStrings(left.filePath, right.filePath));
    const limitedFiles = locatedFiles.slice(0, MAX_SESSION_FILES);
    if (locatedFiles.length > MAX_SESSION_FILES) {
      warnings.push(warning("SESSION_FILE_LIMIT_REACHED", "warning", `Only the first ${MAX_SESSION_FILES} sorted Claude Code session files were considered.`));
    }

    const sessions: ProviderSession[] = [];
    let filesParsed = 0;
    let filesSkipped = Math.max(0, locatedFiles.length - limitedFiles.length);
    for (const located of limitedFiles) {
      const parsed = await parseClaudeCodeFile(located, context);
      filesParsed += 1;
      if (parsed.skipped) filesSkipped += 1;
      if (parsed.session) sessions.push(parsed.session);
      warnings.push(...parsed.warnings);
    }

    const uniqueSessions = new Map<string, ProviderSession>();
    for (const session of sessions) {
      const existing = uniqueSessions.get(session.summary.sessionRef);
      if (!existing || session.summary.endedAt > existing.summary.endedAt) {
        uniqueSessions.set(session.summary.sessionRef, session);
      }
    }
    const deduplicatedSessions = [...uniqueSessions.values()];
    deduplicatedSessions.sort((left, right) => {
      const byStart = compareStrings(left.summary.startedAt, right.summary.startedAt);
      return byStart || compareStrings(left.summary.sessionRef, right.summary.sessionRef);
    });
    const sessionsMatched = deduplicatedSessions.length;
    if (sessionsMatched === 0) {
      warnings.push(warning("NO_MATCHING_SESSIONS", "info", "No Claude Code sessions were scoped to the selected repository."));
    }

    return {
      provider: "claude-code",
      sessionFormat: "claude-code-jsonl",
      rootsConsidered: 1,
      filesDiscovered: locatedFiles.length,
      filesParsed,
      filesSkipped,
      sessionsMatched,
      sessions: deduplicatedSessions,
      warnings,
    };
  }

  public async extractExcerpts(
    sessions: ProviderSession[],
    redactor: Redactor,
    budget: { maxExcerpts: number; maxCharsPerExcerpt: number; maxTotalChars: number },
  ): Promise<ExcerptExtractionResult> {
    return extractClaudeCodeExcerpts(sessions, redactor, budget);
  }
}

// --- Opt-in narrative-evidence excerpt extraction --------------------------
// A second, separate pass over already-matched session files. Never invoked
// by discover()/buildProjectSnapshot(); only reachable through the explicit
// excerpts CLI flow, which requires its own consent and a typed --review
// confirmation. Keeping this fully separate from the main scan path means
// the default scan stays exactly as content-free as before this file existed.

const MAX_EXCERPTS_PER_SESSION = 6;
const MAX_ASSISTANT_DECISIONS_PER_SESSION = 3;
const ASSISTANT_DECISION_MAX_RAW_CHARS = 600;

interface RawExcerptCandidate {
  sessionRef: string;
  occurredAt: string;
  role: "session-title" | "user-intent" | "plan-transition" | "assistant-decision" | "outcome";
  text: string;
}

async function collectRawCandidates(filePath: string, sessionRef: string): Promise<RawExcerptCandidate[]> {
  const candidates: RawExcerptCandidate[] = [];
  let sessionTitle: { text: string; occurredAt: string } | null = null;
  let firstUserMessage: { text: string; occurredAt: string } | null = null;
  let lastUserMessage: { text: string; occurredAt: string } | null = null;
  let lastPermissionMode: string | null = null;
  let pendingAssistantText: { text: string; occurredAt: string } | null = null;
  let assistantDecisions = 0;

  await consumeJsonLines(filePath, (line) => {
    let record: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line.toString("utf8"));
      if (!isRecord(parsed)) return true;
      record = parsed;
    } catch {
      return true;
    }
    const timestamp = isoTimestamp(record.timestamp) ?? new Date(0).toISOString();
    const recordType = asString(record.type);

    if ((recordType === "custom-title" || recordType === "ai-title") && !sessionTitle) {
      const text = asString(recordType === "custom-title" ? record.customTitle : record.aiTitle);
      if (text) sessionTitle = { text, occurredAt: timestamp };
      return true;
    }

    if (recordType !== "user" && recordType !== "assistant") return true;
    if (record.isSidechain === true) return true;
    const message = asRecord(record.message);
    if (!message) return true;

    if (recordType === "user") {
      const content = message.content;
      if (isToolResultContinuation(content)) return true;
      const text = typeof content === "string" ? content : null;
      if (!text) return true;
      const permissionMode = asString(record.permissionMode);
      if (permissionMode && lastPermissionMode !== null && permissionMode !== lastPermissionMode) {
        candidates.push({ sessionRef, occurredAt: timestamp, role: "plan-transition", text });
      }
      if (permissionMode) lastPermissionMode = permissionMode;
      if (!firstUserMessage) firstUserMessage = { text, occurredAt: timestamp };
      lastUserMessage = { text, occurredAt: timestamp };
      pendingAssistantText = null; // a new user turn closes the window for a pre-edit assistant statement
      return true;
    }

    // assistant
    const content = Array.isArray(message.content) ? message.content : [];
    const textBlock = content.find((block): block is JsonRecord => isRecord(block) && block.type === "text");
    const rawText = textBlock ? asString(textBlock.text) : null;
    if (rawText && rawText.length <= ASSISTANT_DECISION_MAX_RAW_CHARS) {
      pendingAssistantText = { text: rawText, occurredAt: timestamp };
    }
    const hasEditOrWrite = content.some(
      (block) => isRecord(block) && block.type === "tool_use" && (block.name === "Edit" || block.name === "Write"),
    );
    if (hasEditOrWrite && pendingAssistantText && assistantDecisions < MAX_ASSISTANT_DECISIONS_PER_SESSION) {
      candidates.push({ sessionRef, ...pendingAssistantText, role: "assistant-decision" });
      assistantDecisions += 1;
      pendingAssistantText = null;
    }
    return true;
  });

  const ordered: RawExcerptCandidate[] = [];
  const title = sessionTitle as { text: string; occurredAt: string } | null;
  const firstUser = firstUserMessage as { text: string; occurredAt: string } | null;
  const lastUser = lastUserMessage as { text: string; occurredAt: string } | null;
  if (title) ordered.push({ sessionRef, role: "session-title", ...title });
  if (firstUser) ordered.push({ sessionRef, role: "user-intent", ...firstUser });
  ordered.push(...candidates);
  // Skip "outcome" if the same text is already captured under another role
  // (e.g. the last user turn is also the message that triggered a
  // plan-transition candidate) - the same excerpt shouldn't consume the
  // budget twice just because it earned two labels.
  if (lastUser && lastUser !== firstUser && !ordered.some((entry) => entry.text === lastUser.text)) {
    ordered.push({ sessionRef, role: "outcome", ...lastUser });
  }
  return ordered.slice(0, MAX_EXCERPTS_PER_SESSION);
}

export async function extractClaudeCodeExcerpts(
  sessions: ProviderSession[],
  redactor: Redactor,
  budget: { maxExcerpts: number; maxCharsPerExcerpt: number; maxTotalChars: number },
): Promise<{ excerpts: NarrativeExcerpt[]; candidates: number; rejectedByRedaction: number; rejectedByBudget: number }> {
  const excerpts: NarrativeExcerpt[] = [];
  let candidateCount = 0;
  let rejectedByRedaction = 0;
  let rejectedByBudget = 0;
  let totalChars = 0;

  for (const session of sessions) {
    if (!session.sourceFilePath) continue;
    const raw = await collectRawCandidates(session.sourceFilePath, session.summary.sessionRef);
    for (const candidate of raw) {
      candidateCount += 1;
      if (excerpts.length >= budget.maxExcerpts) {
        rejectedByBudget += 1;
        continue;
      }
      const cleaned = redactor.cleanExcerpt(candidate.text, budget.maxCharsPerExcerpt);
      if (cleaned === null) {
        rejectedByRedaction += 1;
        continue;
      }
      if (totalChars + cleaned.length > budget.maxTotalChars) {
        rejectedByBudget += 1;
        continue;
      }
      totalChars += cleaned.length;
      excerpts.push({
        excerptId: `exc_${shortHash(`${candidate.sessionRef}\0${candidate.role}\0${candidate.occurredAt}\0${excerpts.length}`, 20)}`,
        sessionRef: candidate.sessionRef,
        occurredAt: candidate.occurredAt,
        role: candidate.role,
        text: cleaned,
      });
    }
  }

  return { excerpts, candidates: candidateCount, rejectedByRedaction, rejectedByBudget };
}
