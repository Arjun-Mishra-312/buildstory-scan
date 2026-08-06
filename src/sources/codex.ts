import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareStrings, sha256, shortHash } from "../canonical-json.js";
import type {
  EvidenceReference,
  QualityWarning,
  SessionStatus,
  SessionSummary,
  TokenUsage,
} from "../contract.js";
import { ASSISTANT_DECISION_MAX_RAW_CHARS, MAX_ASSISTANT_DECISIONS_PER_SESSION, orderSessionCandidates } from "./narrative-evidence.js";
import { consumeJsonLines } from "./jsonl.js";
import { relationToRepository } from "./path-scope.js";
import type {
  NormalizedConversationEvent,
  ProviderDescriptor,
  ProviderDiscoveryContext,
  ProviderDiscoveryResult,
  ProviderSession,
  RawExcerptCandidate,
  SessionProviderAdapter,
} from "./types.js";

const MAX_SESSION_FILES = 5_000;
const MAX_SESSION_FILE_BYTES = 128 * 1024 * 1024;
const MAX_DISCOVERY_LINES = 100;
const MAX_DISCOVERY_DEPTH = 6;

type JsonRecord = Record<string, unknown>;
type SourceKind = SessionSummary["sourceKind"];

interface CodexSourceRoot {
  directory: string;
  kind: SourceKind;
}

interface LocatedSessionFile {
  filePath: string;
  kind: SourceKind;
}

interface ParseResult {
  matched: boolean;
  session?: ProviderSession;
  warnings: QualityWarning[];
  skipped: boolean;
}

interface EventMarker {
  ordinal: number;
  timestamp: string;
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

function parseTokenUsage(payload: JsonRecord): TokenUsage | null {
  const info = asRecord(payload.info);
  const usage = asRecord(info?.total_token_usage ?? payload.total_token_usage);
  if (!usage) return null;
  const inputTokens = asNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = asNonNegativeInteger(usage.cached_input_tokens);
  const outputTokens = asNonNegativeInteger(usage.output_tokens);
  const reasoningOutputTokens = asNonNegativeInteger(usage.reasoning_output_tokens);
  const reportedTotal = asNonNegativeInteger(usage.total_tokens);
  const totalTokens = reportedTotal || inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function warning(
  code: QualityWarning["code"],
  severity: QualityWarning["severity"],
  message: string,
  sessionRef?: string,
): QualityWarning {
  return sessionRef === undefined ? { code, severity, message } : { code, severity, message, sessionRef };
}

async function parseCodexFile(
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
    warnings.push(warning("SESSION_FILE_TOO_LARGE", "warning", "A Codex session exceeded the 128 MiB safety limit and was skipped."));
    return { matched: false, skipped: true, warnings };
  }

  let scope: SessionSummary["workingDirectoryRelation"] | null | undefined;
  let rawSessionId: string | null = null;
  let providerName = "unknown";
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let firstMarker: EventMarker | null = null;
  let lastMarker: EventMarker | null = null;
  let firstToolMarker: EventMarker | null = null;
  let invalidJson = false;
  let invalidTimestamp = false;
  let sawMetadata = false;
  let completed = false;
  let aborted = false;
  let eventUserMessages = 0;
  let responseUserMessages = 0;
  let eventAssistantMessages = 0;
  let responseAssistantMessages = 0;
  let latestTokenUsage: TokenUsage | null = null;
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

    const recordType = asString(record.type);
    const payload = asRecord(record.payload) ?? {};
    const payloadType = asString(payload.type);

    if (recordType === "session_meta") {
      sawMetadata = true;
      rawSessionId = asString(payload.id) ?? rawSessionId;
      providerName = asString(payload.model_provider) ?? providerName;
      const metadataTimestamp = isoTimestamp(payload.timestamp);
      if (metadataTimestamp) {
        firstTimestamp = firstTimestamp === null || metadataTimestamp < firstTimestamp ? metadataTimestamp : firstTimestamp;
      }
      const cwd = asString(payload.cwd);
      if (cwd) scope = relationToRepository(context.repositoryRoot, cwd);
    } else if (scope === undefined && recordType === "turn_context") {
      const cwd = asString(payload.cwd);
      if (cwd) scope = relationToRepository(context.repositoryRoot, cwd);
    }

    if (scope === null) return false;
    if (scope === undefined && ordinal >= MAX_DISCOVERY_LINES) return false;
    if (scope === undefined) return true;

    if (recordType === "turn_context") {
      const rawModel = asString(payload.model);
      if (rawModel) {
        const model = context.redactor.cleanMetadata(rawModel, 160);
        const provider = context.redactor.cleanMetadata(providerName, 80);
        const existing = modelCounts.get(model);
        modelCounts.set(model, { provider, turns: (existing?.turns ?? 0) + 1 });
      }
    }

    if (recordType === "event_msg") {
      if (payloadType === "user_message") {
        eventUserMessages += 1;
        context.redactor.recordTranscriptBodyDiscarded();
      } else if (payloadType === "agent_message") {
        eventAssistantMessages += 1;
        context.redactor.recordTranscriptBodyDiscarded();
      } else if (payloadType === "agent_reasoning") {
        context.redactor.recordTranscriptBodyDiscarded();
      } else if (payloadType === "task_complete" || payloadType === "task_completed") {
        completed = true;
      } else if (payloadType === "turn_aborted" || payloadType === "task_aborted") {
        aborted = true;
      } else if (payloadType === "token_count") {
        latestTokenUsage = parseTokenUsage(payload) ?? latestTokenUsage;
      }
    }

    if (recordType === "response_item") {
      if (payloadType === "message") {
        const role = asString(payload.role);
        if (role === "user") responseUserMessages += 1;
        if (role === "assistant") responseAssistantMessages += 1;
        context.redactor.recordTranscriptBodyDiscarded();
      } else if (payloadType === "reasoning") {
        context.redactor.recordTranscriptBodyDiscarded();
      }

      let rawToolName: string | null = null;
      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        rawToolName = asString(payload.name) ?? "unknown-tool";
        context.redactor.recordToolPayloadDiscarded();
      } else if (payloadType === "web_search_call") {
        rawToolName = "web_search";
        context.redactor.recordToolPayloadDiscarded();
      } else if (payloadType === "local_shell_call") {
        rawToolName = "local_shell";
        context.redactor.recordToolPayloadDiscarded();
      } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        context.redactor.recordToolPayloadDiscarded();
      }

      if (rawToolName) {
        const toolName = context.redactor.cleanMetadata(rawToolName, 160);
        addCount(toolCounts, toolName);
        if (timestamp && firstToolMarker === null) firstToolMarker = { ordinal, timestamp };
      }
    }
    return true;
  });

  if (scope !== "repository-root" && scope !== "subdirectory") {
    if (!sawMetadata) {
      warnings.push(warning("SESSION_MISSING_METADATA", "info", "A Codex JSONL file had no repository-scoping metadata in its discovery prefix."));
    }
    return { matched: false, skipped: false, warnings };
  }

  const fallbackIdentity = `${located.kind}:${path.basename(located.filePath)}`;
  const sessionRef = `ses_${shortHash(`${context.repositoryFingerprint}\0${rawSessionId ?? fallbackIdentity}`, 20)}`;
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
  const toolMarker = firstToolMarker as EventMarker | null;
  if (!firstTimestamp || !lastTimestamp || !startMarker || !endMarker) {
    warnings.push(warning("SESSION_TIMESTAMP_INVALID", "warning", "A matched session had no usable timestamp and was excluded.", sessionRef));
    return { matched: true, skipped: true, warnings };
  }

  if (modelCounts.size === 0) {
    warnings.push(warning("SESSION_MODEL_UNKNOWN", "info", "No model identifier was present in the session metadata.", sessionRef));
  }
  const status: SessionStatus = aborted ? "aborted" : completed ? "completed" : "incomplete";
  if (status === "incomplete" && located.kind === "active") {
    warnings.push(warning("SESSION_ACTIVE_AT_SCAN_END", "info", "An active Codex session had no completion marker at the observed boundary.", sessionRef));
  }

  const turns = eventUserMessages || responseUserMessages;
  const assistantMessages = eventAssistantMessages || responseAssistantMessages;
  const toolCalls = [...toolCounts.values()].reduce((sum, count) => sum + count, 0);
  const summaryText = context.redactor.cleanMetadata(
    `Codex session with ${turns} user turn${turns === 1 ? "" : "s"}, ${assistantMessages} assistant message${assistantMessages === 1 ? "" : "s"}, and ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}.`,
    240,
  );

  const evidence: EvidenceReference[] = [];
  const addEvidence = (kind: EvidenceReference["kind"], marker: EventMarker): void => {
    const seed = `${sessionRef}\0${kind}\0${marker.ordinal}\0${marker.timestamp}`;
    evidence.push({
      evidenceId: `ev_${shortHash(seed, 20)}`,
      source: "codex",
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
        provider: "codex",
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
        tokenUsage: latestTokenUsage,
      },
      toolCounts,
      modelCounts,
      evidence: evidence.sort((left, right) => compareStrings(left.evidenceId, right.evidenceId)),
      sourceFilePath: located.filePath,
    },
  };
}

function extractResponseMessageText(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block)) {
        const text = asString(block.text);
        if (text) return text;
      }
    }
  }
  return null;
}

async function discoverRootFiles(root: CodexSourceRoot): Promise<{ files: LocatedSessionFile[]; available: boolean; limitReached: boolean }> {
  try {
    const rootStat = await lstat(root.directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { files: [], available: false, limitReached: false };
  } catch {
    return { files: [], available: false, limitReached: false };
  }

  const files: LocatedSessionFile[] = [];
  let limitReached = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DISCOVERY_DEPTH) return;
    if (files.length >= MAX_SESSION_FILES) {
      limitReached = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (files.length >= MAX_SESSION_FILES) {
        limitReached = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLocaleLowerCase("en-US").endsWith(".jsonl")) {
        files.push({ filePath: entryPath, kind: root.kind });
      }
    }
  };
  await walk(root.directory, 0);
  return { files, available: true, limitReached };
}

export interface CodexAdapterOptions {
  codexHome?: string;
}

export class CodexSessionAdapter implements SessionProviderAdapter {
  public readonly provider = "codex" as const;
  public readonly sessionFormat = "codex-jsonl" as const;
  public readonly descriptor: ProviderDescriptor = {
    id: "codex",
    displayName: "Codex",
    sessionFormat: "codex-jsonl",
    capabilities: { metadata: true, narrativeEvidence: true },
    formatVersions: ["codex-jsonl-v1"],
  };
  private readonly roots: CodexSourceRoot[];

  public constructor(options: CodexAdapterOptions = {}) {
    const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const kind: SourceKind = options.codexHome ? "custom" : "active";
    this.roots = [
      { directory: path.join(codexHome, "sessions"), kind },
      { directory: path.join(codexHome, "archived_sessions"), kind: options.codexHome ? "custom" : "archived" },
    ];
  }

  public async discover(context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult> {
    const warnings: QualityWarning[] = [];
    const locatedFiles: LocatedSessionFile[] = [];
    let rootLimitReached = false;
    for (const root of this.roots) {
      const discovered = await discoverRootFiles(root);
      if (!discovered.available) warnings.push(warning("CODEX_ROOT_UNAVAILABLE", "info", "A configured Codex session root was unavailable and was skipped."));
      if (discovered.limitReached) rootLimitReached = true;
      locatedFiles.push(...discovered.files);
    }

    locatedFiles.sort((left, right) => compareStrings(left.filePath, right.filePath));
    const limitedFiles = locatedFiles.slice(0, MAX_SESSION_FILES);
    if (rootLimitReached || locatedFiles.length > MAX_SESSION_FILES) {
      warnings.push(warning("SESSION_FILE_LIMIT_REACHED", "warning", `Only the first ${MAX_SESSION_FILES} sorted Codex session files were considered.`));
    }

    const sessions: ProviderSession[] = [];
    let filesParsed = 0;
    let filesSkipped = Math.max(0, locatedFiles.length - limitedFiles.length);
    let sessionsMatched = 0;
    for (const located of limitedFiles) {
      const parsed = await parseCodexFile(located, context);
      filesParsed += 1;
      if (parsed.skipped) filesSkipped += 1;
      if (parsed.matched) sessionsMatched += 1;
      if (parsed.session) sessions.push(parsed.session);
      warnings.push(...parsed.warnings);
    }

    const uniqueSessions = new Map<string, ProviderSession>();
    for (const session of sessions) {
      const existing = uniqueSessions.get(session.summary.sessionRef);
      if (
        !existing
        || session.summary.endedAt > existing.summary.endedAt
        || (session.summary.endedAt === existing.summary.endedAt && session.summary.sourceKind === "active")
      ) {
        uniqueSessions.set(session.summary.sessionRef, session);
      }
    }
    const deduplicatedSessions = [...uniqueSessions.values()];
    deduplicatedSessions.sort((left, right) => {
      const byStart = compareStrings(left.summary.startedAt, right.summary.startedAt);
      return byStart || compareStrings(left.summary.sessionRef, right.summary.sessionRef);
    });
    sessionsMatched = deduplicatedSessions.length;
    if (sessionsMatched === 0) {
      warnings.push(warning("NO_MATCHING_SESSIONS", "info", "No Codex sessions were scoped to the selected repository."));
    }

    return {
      provider: "codex",
      sessionFormat: "codex-jsonl",
      rootsConsidered: this.roots.length,
      filesDiscovered: locatedFiles.length,
      filesParsed,
      filesSkipped,
      sessionsMatched,
      sessions: deduplicatedSessions,
      warnings,
    };
  }

  // --- Opt-in narrative-evidence: shared-shape read + provider recognition -
  // Same second-pass pattern as ClaudeCodeSessionAdapter: never invoked by
  // discover()/buildProjectSnapshot(), only reachable through the shared
  // selector's own excerpts pass.

  public async readEvents(
    session: ProviderSession,
    _context: ProviderDiscoveryContext,
  ): Promise<NormalizedConversationEvent[]> {
    if (!session.sourceFilePath) return [];
    const sessionRef = session.summary.sessionRef;
    // Codex records the same conversation twice - once as compact event_msg
    // records, once as full response_item records - so event-sourced text is
    // preferred over response-sourced text when both are present, mirroring
    // the "turns = eventUserMessages || responseUserMessages" preference
    // already used for metrics in parseCodexFile above.
    const eventSourced: NormalizedConversationEvent[] = [];
    const responseSourced: NormalizedConversationEvent[] = [];
    const toolCalls: NormalizedConversationEvent[] = [];
    let ordinal = 0;

    await consumeJsonLines(session.sourceFilePath, (line) => {
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
      const payload = asRecord(record.payload) ?? {};
      const payloadType = asString(payload.type);

      if (recordType === "event_msg") {
        if (payloadType === "user_message") {
          const text = asString(payload.message);
          if (text) {
            ordinal += 1;
            eventSourced.push({ provider: "codex", sessionRef, ordinal, occurredAt: timestamp, role: "user", text, eventKind: "message" });
          }
        } else if (payloadType === "agent_message") {
          const text = asString(payload.message);
          if (text) {
            ordinal += 1;
            eventSourced.push({ provider: "codex", sessionRef, ordinal, occurredAt: timestamp, role: "assistant", text, eventKind: "message" });
          }
        }
        return true;
      }

      if (recordType === "response_item") {
        if (payloadType === "message") {
          const role = asString(payload.role);
          const text = extractResponseMessageText(payload.content);
          if (text && (role === "user" || role === "assistant")) {
            ordinal += 1;
            responseSourced.push({ provider: "codex", sessionRef, ordinal, occurredAt: timestamp, role, text, eventKind: "message" });
          }
          return true;
        }
        let toolName: string | null = null;
        if (payloadType === "function_call" || payloadType === "custom_tool_call") {
          toolName = asString(payload.name) ?? "unknown-tool";
        } else if (payloadType === "web_search_call") {
          toolName = "web_search";
        } else if (payloadType === "local_shell_call") {
          toolName = "local_shell";
        }
        if (toolName) {
          ordinal += 1;
          toolCalls.push({ provider: "codex", sessionRef, ordinal, occurredAt: timestamp, role: "assistant", text: null, eventKind: "tool-call", toolName });
        }
      }
      return true;
    });

    const messageEvents = eventSourced.length > 0 ? eventSourced : responseSourced;
    return [...messageEvents, ...toolCalls].sort((left, right) => left.ordinal - right.ordinal);
  }

  public extractCandidates(sessionRef: string, events: NormalizedConversationEvent[]): RawExcerptCandidate[] {
    let firstUser: { text: string; occurredAt: string } | null = null;
    let lastUser: { text: string; occurredAt: string } | null = null;
    let pendingAssistantText: { text: string; occurredAt: string } | null = null;
    let assistantDecisions = 0;
    const turningPoints: RawExcerptCandidate[] = [];

    for (const event of events) {
      if (event.role === "user" && event.eventKind === "message" && event.text) {
        if (!firstUser) firstUser = { text: event.text, occurredAt: event.occurredAt };
        lastUser = { text: event.text, occurredAt: event.occurredAt };
        pendingAssistantText = null;
        continue;
      }
      if (event.role === "assistant" && event.eventKind === "message" && event.text && event.text.length <= ASSISTANT_DECISION_MAX_RAW_CHARS) {
        pendingAssistantText = { text: event.text, occurredAt: event.occurredAt };
        continue;
      }
      // Codex has no Edit/Write-named tool taxonomy to filter on the way
      // Claude Code does, so any tool call immediately following assistant
      // text is treated as the turning point - a deliberately broader
      // heuristic for this provider's local format.
      if (event.role === "assistant" && event.eventKind === "tool-call") {
        if (pendingAssistantText && assistantDecisions < MAX_ASSISTANT_DECISIONS_PER_SESSION) {
          turningPoints.push({ sessionRef, ...pendingAssistantText, role: "assistant-decision" });
          assistantDecisions += 1;
          pendingAssistantText = null;
        }
      }
    }

    return orderSessionCandidates(sessionRef, { sessionTitle: null, firstUser, lastUser, turningPoints });
  }
}
