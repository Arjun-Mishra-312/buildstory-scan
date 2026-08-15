import { lstat, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareStrings, sha256, shortHash } from "../canonical-json.js";
import type { EvidenceReference, QualityWarning, SessionStatus, SessionSummary } from "../contract.js";
import {
  ASSISTANT_DECISION_MAX_RAW_CHARS,
  MAX_ASSISTANT_DECISIONS_PER_SESSION,
  orderSessionCandidates,
} from "./narrative-evidence.js";
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

/**
 * Best-effort, flagged adapter for Cursor. Research (2026-08) corroborated
 * across multiple independent community sources: Cursor stores one SQLite
 * `state.vscdb` per workspace under `.../User/workspaceStorage/<hash>/`,
 * alongside a `workspace.json` recording that workspace's folder URI - the
 * same convention every VS Code fork uses, which is why repository-scope
 * detection here is treated as reliable. The chat-data table/key names
 * (`ItemTable` / `workbench.panel.aichat.view.aichat.chatdata`, or the newer
 * `cursorDiskKV` / `aiService.*` keys) are also corroborated by multiple
 * independent sources, but the exact JSON *message* schema inside those
 * blobs is not - even the community tools that read it describe falling
 * back to "scan for anything shaped like a message" rather than a fixed
 * path. This adapter does the same defensive generic scan, never throws out
 * of discover()/readEvents() on an unexpected shape, and always reports
 * PROVIDER_FORMAT_UNVERIFIED whenever it actually parses session content -
 * so a wrong guess here degrades to "fewer/no candidates found", never to a
 * crash or a false claim of full confidence.
 */

const MAX_WORKSPACES = 2_000;
const MAX_WORKSPACE_JSON_BYTES = 64 * 1024;
const MAX_ROW_VALUE_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_DEPTH = 8;
const MAX_MESSAGES_PER_SESSION = 2_000;

const CHAT_DATA_KEYS = ["workbench.panel.aichat.view.aichat.chatdata"];
const DISK_KV_PREFIXES = ["aiService.prompts", "aiService.generations", "composerData:"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    // Cursor/VS Code commonly serializes Windows folders as `file://C:/...`
    // (two slashes) rather than the standards-compliant `file:///C:/...`.
    // Normalize that harmless variant before delegating to Node's URL parser.
    const normalized = /^file:\/\/[A-Za-z]:\//.test(uri) ? `file:///${uri.slice("file://".length)}` : uri;
    return fileURLToPath(normalized);
  } catch {
    return null;
  }
}

function platformWorkspaceStorageRoots(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Cursor", "User", "workspaceStorage")];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage")];
  }
  return [path.join(home, ".config", "Cursor", "User", "workspaceStorage")];
}

interface CandidateWorkspace {
  hash: string;
  directory: string;
  dbPath: string;
}

async function discoverWorkspaces(root: string): Promise<{ workspaces: CandidateWorkspace[]; available: boolean }> {
  let entries;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { workspaces: [], available: false };
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { workspaces: [], available: false };
  }
  const workspaces = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareStrings)
    .slice(0, MAX_WORKSPACES)
    .map((hash) => ({ hash, directory: path.join(root, hash), dbPath: path.join(root, hash, "state.vscdb") }));
  return { workspaces, available: true };
}

async function workspaceFolderPath(directory: string): Promise<string | null> {
  const workspaceJsonPath = path.join(directory, "workspace.json");
  try {
    const stat = await lstat(workspaceJsonPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORKSPACE_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(workspaceJsonPath, "utf8"));
    if (!isRecord(parsed)) return null;
    const folder = asString(parsed.folder);
    return folder ? fileUriToPath(folder) : null;
  } catch {
    return null;
  }
}

/** Recursively finds objects shaped like { role, text|content }. Bounded by depth and count - the format is unverified, so this must never loop unbounded on attacker- or corruption-shaped input. */
function findMessageLikeObjects(
  value: unknown,
  out: Array<{ role: string; text: string }>,
  depth = 0,
): void {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_MESSAGES_PER_SESSION) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= MAX_MESSAGES_PER_SESSION) return;
      findMessageLikeObjects(item, out, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  const role = asString(value.role) ?? asString(value.type);
  const text =
    asString(value.text) ??
    asString(value.content) ??
    (typeof value.content === "string" ? value.content : null);
  if (role && text && (role === "user" || role === "assistant")) {
    out.push({ role, text });
  }
  for (const child of Object.values(value)) {
    if (out.length >= MAX_MESSAGES_PER_SESSION) return;
    if (isRecord(child) || Array.isArray(child)) findMessageLikeObjects(child, out, depth + 1);
  }
}

interface ReadDbResult {
  messages: Array<{ role: string; text: string }>;
  warnings: QualityWarning[];
}

/**
 * Opens state.vscdb strictly read-only via node:sqlite (bundled since Node
 * 22.5, this package's engines floor), runs only the two documented lookups
 * above, and never mutates -wal/-journal state. Any failure (missing
 * module, missing table, corrupt file, unexpected row shape) degrades to an
 * empty read plus a content-free warning - it never throws out to the
 * caller, matching every other adapter's "one provider's parser failure
 * must not abort the scan" rule.
 */
async function readChatDataReadOnly(dbPath: string): Promise<ReadDbResult> {
  const warnings: QualityWarning[] = [];
  try {
    const stat = await lstat(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ROW_VALUE_BYTES) {
      return { messages: [], warnings };
    }
  } catch {
    return { messages: [], warnings };
  }

  type SqliteModule = typeof import("node:sqlite");
  type DatabaseSyncInstance = InstanceType<SqliteModule["DatabaseSync"]>;
  let DatabaseSyncCtor: SqliteModule["DatabaseSync"] | null = null;
  try {
    const { suppressExperimentalSqliteWarning } = await import("../tui/suppress-warnings.js");
    suppressExperimentalSqliteWarning();
    const sqliteModule: SqliteModule = await import("node:sqlite");
    DatabaseSyncCtor = sqliteModule.DatabaseSync;
  } catch {
    warnings.push({
      code: "PROVIDER_FORMAT_UNVERIFIED",
      severity: "info",
      message: "Cursor's local database could not be opened because this Node runtime has no built-in SQLite support; no sessions were read.",
    });
    return { messages: [], warnings };
  }

  let db: DatabaseSyncInstance | null = null;
  const messages: Array<{ role: string; text: string }> = [];
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true, open: true });
    for (const key of CHAT_DATA_KEYS) {
      try {
        const rows = db.prepare("SELECT value FROM ItemTable WHERE key = ?").all(key) as Array<{ value: unknown }>;
        for (const row of rows) {
          const text = typeof row.value === "string" ? row.value : null;
          if (!text) continue;
          try {
            findMessageLikeObjects(JSON.parse(text), messages);
          } catch {
            // Not JSON, or not the shape we expect - skip, don't fail the whole read.
          }
        }
      } catch {
        // ItemTable or this key may not exist in every Cursor version.
      }
    }
    try {
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV").all() as Array<{ key: unknown; value: unknown }>;
      for (const row of rows) {
        const key = typeof row.key === "string" ? row.key : "";
        if (!DISK_KV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        const text = typeof row.value === "string" ? row.value : null;
        if (!text) continue;
        try {
          findMessageLikeObjects(JSON.parse(text), messages);
        } catch {
          // Same defensive skip as above.
        }
      }
    } catch {
      // cursorDiskKV is the newer table shape; older installs may not have it.
    }
  } catch {
    warnings.push({
      code: "PROVIDER_FORMAT_UNVERIFIED",
      severity: "info",
      message: "A Cursor local database could not be read; treated as zero sessions for that workspace.",
    });
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing further to do if close itself fails.
    }
  }

  if (messages.length > 0) {
    warnings.push({
      code: "PROVIDER_FORMAT_UNVERIFIED",
      severity: "info",
      message: "Cursor's local conversation format is not yet verified against a real installation; session metrics are best-effort.",
    });
  }
  return { messages: messages.slice(0, MAX_MESSAGES_PER_SESSION), warnings };
}

export interface CursorAdapterOptions {
  cursorHome?: string;
}

export class CursorSessionAdapter implements SessionProviderAdapter {
  public readonly provider = "cursor" as const;
  public readonly sessionFormat = "cursor-sqlite" as const;
  public readonly descriptor: ProviderDescriptor = {
    id: "cursor",
    displayName: "Cursor",
    sessionFormat: "cursor-sqlite",
    capabilities: { metadata: true, narrativeEvidence: true },
    formatVersions: ["unverified-community-format-v1"],
  };
  private readonly roots: string[];

  public constructor(options: CursorAdapterOptions = {}) {
    this.roots = options.cursorHome
      ? [options.cursorHome]
      : process.env.CURSOR_HOME
        ? [process.env.CURSOR_HOME]
        : platformWorkspaceStorageRoots();
  }

  public async discover(context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult> {
    const warnings: QualityWarning[] = [];
    let rootAvailable = false;
    const scopedWorkspaces: CandidateWorkspace[] = [];
    let filesDiscovered = 0;

    for (const root of this.roots) {
      const discovered = await discoverWorkspaces(root);
      if (discovered.available) rootAvailable = true;
      filesDiscovered += discovered.workspaces.length;
      for (const workspace of discovered.workspaces) {
        const folder = await workspaceFolderPath(workspace.directory);
        if (!folder) continue;
        const scope = relationToRepository(context.repositoryRoot, folder);
        if (scope === null) continue;
        scopedWorkspaces.push(workspace);
      }
    }

    if (!rootAvailable) {
      warnings.push({
        code: "CURSOR_ROOT_UNAVAILABLE",
        severity: "info",
        message: "Cursor's local workspace storage directory was not found; treated as not installed.",
      });
      return {
        provider: "cursor",
        sessionFormat: "cursor-sqlite",
        rootsConsidered: this.roots.length,
        filesDiscovered: 0,
        filesParsed: 0,
        filesSkipped: 0,
        sessionsMatched: 0,
        sessions: [],
        warnings,
      };
    }

    const sessions: ProviderSession[] = [];
    let filesParsed = 0;
    let filesSkipped = 0;
    for (const workspace of scopedWorkspaces) {
      filesParsed += 1;
      const { messages, warnings: readWarnings } = await readChatDataReadOnly(workspace.dbPath);
      warnings.push(...readWarnings);
      if (messages.length === 0) {
        filesSkipped += 1;
        continue;
      }

      let stat;
      try {
        stat = await lstat(workspace.dbPath);
      } catch {
        filesSkipped += 1;
        continue;
      }
      const observedAt = stat.mtime.toISOString();
      const sessionRef = `ses_${shortHash(`cursor\0${context.repositoryFingerprint}\0${workspace.hash}`, 20)}`;
      const turns = messages.filter((message) => message.role === "user").length;
      const assistantMessages = messages.filter((message) => message.role === "assistant").length;
      const status: SessionStatus = "unknown";
      const scope = (await workspaceFolderPath(workspace.directory).then((folder) =>
        folder ? relationToRepository(context.repositoryRoot, folder) : null,
      )) as SessionSummary["workingDirectoryRelation"] | null;
      if (scope !== "repository-root" && scope !== "subdirectory") {
        filesSkipped += 1;
        continue;
      }

      const summaryText = context.redactor.cleanMetadata(
        `Cursor session with ${turns} user turn${turns === 1 ? "" : "s"} and ${assistantMessages} assistant message${assistantMessages === 1 ? "" : "s"} (unverified local format).`,
        240,
      );
      const evidenceOrdinal = 0;
      const evidenceSeed = `${sessionRef}\0session-boundary\0${evidenceOrdinal}\0${observedAt}`;
      const evidence: EvidenceReference[] = [
        {
          evidenceId: `ev_${shortHash(evidenceSeed, 20)}`,
          source: "cursor",
          kind: "session-boundary",
          observedAt,
          digest: sha256(evidenceSeed),
          sessionRef,
          eventOrdinal: 0,
        },
      ];
      if (turns === 0 && assistantMessages === 0) {
        warnings.push({
          code: "SESSION_MISSING_METADATA",
          severity: "info",
          message: "A Cursor workspace database had no recognizable user or assistant messages in its unverified local format.",
          sessionRef,
        });
      }

      sessions.push({
        summary: {
          sessionRef,
          provider: "cursor",
          sourceKind: "active",
          startedAt: observedAt,
          endedAt: observedAt,
          status,
          workingDirectoryRelation: scope,
          summary: summaryText,
          turns,
          assistantMessages,
          toolCalls: 0,
          modelRefs: [],
          toolRefs: [],
          tokenUsage: null,
        },
        toolCounts: new Map(),
        modelCounts: new Map(),
        evidence,
        sourceFilePath: workspace.dbPath,
      });
    }

    sessions.sort((left, right) => {
      const byStart = compareStrings(left.summary.startedAt, right.summary.startedAt);
      return byStart || compareStrings(left.summary.sessionRef, right.summary.sessionRef);
    });
    if (sessions.length === 0) {
      warnings.push({
        code: "NO_MATCHING_SESSIONS",
        severity: "info",
        message: "No Cursor sessions were scoped to the selected repository.",
      });
    }

    return {
      provider: "cursor",
      sessionFormat: "cursor-sqlite",
      rootsConsidered: this.roots.length,
      filesDiscovered,
      filesParsed,
      filesSkipped,
      sessionsMatched: sessions.length,
      sessions,
      warnings,
    };
  }

  // --- Opt-in narrative-evidence: best-effort, same defensive read pattern -
  // as discover(). sourceFilePath here is the workspace's state.vscdb path;
  // readEvents re-reads it read-only rather than caching message bodies
  // from discover(), keeping every provider's narrative-evidence pass a
  // clearly separate, opt-in-only second pass over the same local file.

  public async readEvents(
    session: ProviderSession,
    _context: ProviderDiscoveryContext,
  ): Promise<NormalizedConversationEvent[]> {
    if (!session.sourceFilePath) return [];
    const { messages } = await readChatDataReadOnly(session.sourceFilePath);
    const sessionRef = session.summary.sessionRef;
    return messages.map((message, index) => ({
      provider: "cursor" as const,
      sessionRef,
      ordinal: index,
      occurredAt: session.summary.startedAt,
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      text: message.text,
      eventKind: "message" as const,
    }));
  }

  public extractCandidates(sessionRef: string, events: NormalizedConversationEvent[]): RawExcerptCandidate[] {
    let firstUser: { text: string; occurredAt: string } | null = null;
    let lastUser: { text: string; occurredAt: string } | null = null;
    let pendingAssistantText: { text: string; occurredAt: string } | null = null;
    let assistantDecisions = 0;
    const turningPoints: RawExcerptCandidate[] = [];

    for (const event of events) {
      if (event.role === "user" && event.text) {
        if (!firstUser) firstUser = { text: event.text, occurredAt: event.occurredAt };
        lastUser = { text: event.text, occurredAt: event.occurredAt };
        // No tool-call event kind is emitted for this unverified format, so
        // there is no signal to turn a pending assistant statement into an
        // "assistant-decision" candidate here - it simply expires.
        pendingAssistantText = null;
        continue;
      }
      if (event.role === "assistant" && event.text && event.text.length <= ASSISTANT_DECISION_MAX_RAW_CHARS) {
        pendingAssistantText = { text: event.text, occurredAt: event.occurredAt };
        if (assistantDecisions < MAX_ASSISTANT_DECISIONS_PER_SESSION) {
          // No mutating-tool signal exists for this format, so every short
          // assistant statement is itself the closest available "decision"
          // turning point rather than requiring a following tool call.
          turningPoints.push({ sessionRef, ...pendingAssistantText, role: "assistant-decision" });
          assistantDecisions += 1;
        }
      }
    }

    return orderSessionCandidates(sessionRef, { sessionTitle: null, firstUser, lastUser, turningPoints });
  }
}
