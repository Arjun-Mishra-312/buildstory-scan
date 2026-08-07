#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./canonical-json.js";
import { connectBuildStory } from "./connect.js";
import type { ProjectSnapshot, ProviderId } from "./contract.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, SCANNER_VERSION } from "./contract.js";
import { getStoredUploadGrant } from "./connection-state.js";
import { ScannerError, safeErrorMessage } from "./errors.js";
import { readLocalDashboardStatus, uploadProjectSnapshot } from "./local-upload.js";
import { createOllamaNarrativeGenerator, LocalNarrativeGenerationError } from "./narrative/local.js";
import { writeSnapshotFile } from "./output.js";
import { Redactor } from "./redaction.js";
import { inspectRepository } from "./repository.js";
import { buildProjectSnapshot, inspectSelectedRepository, providerLabel } from "./scanner.js";
import { isRegisteredProvider, REGISTERED_PROVIDER_IDS } from "./sources/registry.js";
import type { ScanProgressEvent, ScanProgressReporter } from "./progress.js";

const TOKEN_MAGNITUDES: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
];

function compactTokenCount(total: number): string {
  for (const [threshold, suffix] of TOKEN_MAGNITUDES) {
    if (total >= threshold) return `${(total / threshold).toFixed(1)}${suffix}`;
  }
  return String(total);
}

/** ", 12.3K tokens, est. $4.82" - empty when the snapshot has no token usage to report. */
function usageSummarySuffix(snapshot: ProjectSnapshot): string {
  const tokens = snapshot.usage.tokenUsage;
  if (!tokens || tokens.totalTokens === 0) return "";
  const totalMicroUsd = snapshot.usage.cost.totalMicroUsd;
  const costSuffix = totalMicroUsd === null ? "" : `, est. $${(totalMicroUsd / 1_000_000).toFixed(2)}`;
  return `, ${compactTokenCount(tokens.totalTokens)} tokens${costSuffix}`;
}

/** The canonical hosted origin --remote expands to; kept separate from user input so it is never itself an injectable value. */
const DEFAULT_REMOTE_API_BASE_URL = "https://buildstory.dev/";
const DEFAULT_REMOTE_HOST = "buildstory.dev";

/**
 * The installed binary name. Deliberately not "buildstory": that name, and the
 * old "story-scanner" alias, are both already published on npm by unrelated
 * authors, so a global install of either would collide. This is a distribution
 * detail only - provenance.scanner.name stays "buildstory" because the
 * ProjectSnapshot schema pins it to an enum and the server validates it.
 */
const CLI_COMMAND = "buildstory-scan";

const HELP = `BuildStory CLI ${SCANNER_VERSION}

Read-only local scanner. ProjectSnapshot transport is loopback by default, or
a single explicitly pinned HTTPS remote host per connection.

Usage:
  ${CLI_COMMAND} connect <upload-session-id> --code <device-code> --api-base-url <loopback-url>
  ${CLI_COMMAND} connect <upload-session-id> --code <device-code> --remote
  ${CLI_COMMAND} connect <upload-session-id> --code <device-code> --api-base-url <https-url> --allow-host <hostname>
  ${CLI_COMMAND} status [--timeout-ms <number>]
  ${CLI_COMMAND} inspect --repo <directory>
  ${CLI_COMMAND} scan --repo <directory> --consent local-scan --dry-run
  ${CLI_COMMAND} scan --repo <directory> --consent local-scan --output <file> [--overwrite]
  ${CLI_COMMAND} scan-upload --repo <directory> --consent local-scan --upload-consent local-dashboard

Connection options:
  --code <device-code>       One-time code copied from the dashboard.
  --api-base-url <url>       Loopback HTTP(S), or an HTTPS remote host paired
                             with --allow-host. BUILDSTORY_API_BASE_URL is a
                             fallback. mock://local tests parsing but creates
                             no upload grant.
  --allow-host <hostname>    Required with a non-loopback --api-base-url.
                             Must exactly match its hostname - a deliberate
                             second confirmation before any grant is sent
                             off this machine.
  --remote                   Shorthand for --api-base-url https://${DEFAULT_REMOTE_HOST}/
                             --allow-host ${DEFAULT_REMOTE_HOST}. Cannot be combined
                             with --api-base-url or --allow-host.
  --timeout-ms <number>      API timeout from 100 to 60000 ms.

Scanner options:
  --repo <directory>         Selected Git worktree (required; use . for the current repo).
  --project-name <name>      Override the redacted project display name for a rare identifier collision.
  --source <list>            Comma-separated providers to scan: codex, claude-code,
                             cursor, gemini-antigravity - or "all" (default).
                             gemini-antigravity is currently detection-only
                             (installed/not-installed only, no session data);
                             cursor is a best-effort, format-unverified adapter.
  --codex-home <directory>   Override the Codex session root.
  --claude-code-home <directory>
                             Override the Claude Code config directory (parent of "projects").
  --cursor-home <directory>  Override the Cursor workspaceStorage root.
  --antigravity-home <directory>
                             Override Google Antigravity's local data directory.
  --since <ISO-8601>         Inclusive activity-window start.
  --until <ISO-8601>         Inclusive activity-window end.
  --consent local-scan       Allow local repository/session metadata reads.
  --upload-consent local-dashboard
                             Separately allow this validated snapshot to the connected loopback dashboard.
  --dry-run                  Validate and print the redacted snapshot; write no file.
  --output <file>            Atomically write outside the selected repository.
  --overwrite                Replace an existing regular output file.
  --with-evidence            In cloud mode, opt in to a small, redacted set of
                             conversation excerpts (narrativeEvidence). Off by
                             default. Requires --review.
  --review                   In cloud mode, print exact excerpts; in local
                             mode, preview generated prose. Require confirmation.
  --require-evidence         Strict mode: exit before upload/write if the
                             evidence bundle would be empty. Requires
                             --with-evidence. Without this flag, an empty
                             bundle still proceeds as a metrics-only snapshot.
  --quiet                    Suppress progress and non-error success output.
  --help                     Show this help.
  --version                  Show the scanner version.

connect never scans or uploads. scan never uses the network. scan-upload is the
only snapshot network path, and only ever talks to the single endpoint pinned
during the preceding connect (loopback, or the one --allow-host/--remote host).
It sends exactly one canonical, schema-validated ProjectSnapshot ${PROJECT_SNAPSHOT_SCHEMA_VERSION}
using a short-lived, one-use grant. Browser cookies, redirects, unpinned hosts,
source/file bodies, diffs, transcript bodies, tool arguments/results, file
paths, and secret text are not sent.

Local mode is the default for new connections and calls Ollama on loopback;
generatedNarrative is uploaded but narrativeEvidence is never uploaded. Cloud
mode is explicit and, with --review confirmation, includes a bounded set of
redacted excerpts. Off mode uploads deterministic metrics/profile facts only.
`;

interface ParsedScannerArguments {
  command: "inspect" | "scan" | "scan-upload";
  repo: string;
  projectName?: string;
  source: ProviderId[];
  codexHome?: string;
  claudeCodeHome?: string;
  cursorHome?: string;
  antigravityHome?: string;
  since?: string;
  until?: string;
  consent?: string;
  uploadConsent?: string;
  dryRun: boolean;
  output?: string;
  overwrite: boolean;
  withEvidence: boolean;
  review: boolean;
  requireEvidence: boolean;
  quiet: boolean;
}

interface ParsedConnectArguments {
  command: "connect";
  uploadSessionId: string;
  deviceCode: string;
  apiBaseUrl?: string;
  allowHost?: string;
  timeoutMilliseconds?: number;
}

interface ParsedStatusArguments {
  command: "status";
  timeoutMilliseconds?: number;
}

type ParsedArguments = ParsedScannerArguments | ParsedConnectArguments | ParsedStatusArguments;

const SCANNER_VALUE_OPTIONS = new Set([
  "--repo",
  "--project-name",
  "--source",
  "--codex-home",
  "--claude-code-home",
  "--cursor-home",
  "--antigravity-home",
  "--since",
  "--until",
  "--consent",
  "--upload-consent",
  "--output",
]);
const SCANNER_BOOLEAN_OPTIONS = new Set(["--dry-run", "--overwrite", "--quiet", "--with-evidence", "--review", "--require-evidence"]);
const CONNECT_VALUE_OPTIONS = new Set(["--code", "--api-base-url", "--allow-host", "--timeout-ms"]);
const CONNECT_BOOLEAN_OPTIONS = new Set(["--remote"]);

function parseTimeout(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) return undefined;
  if (!/^\d+$/.test(rawValue)) {
    throw new ScannerError("TIMEOUT_INVALID", "--timeout-ms must be an integer from 100 to 60000.", 2);
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new ScannerError("TIMEOUT_INVALID", "--timeout-ms must be an integer from 100 to 60000.", 2);
  }
  return value;
}

function parseConnectArguments(argv: string[]): ParsedConnectArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (CONNECT_BOOLEAN_OPTIONS.has(argument)) {
      if (flags.has(argument)) throw new ScannerError("DUPLICATE_OPTION", `${argument} may be supplied only once.`, 2);
      flags.add(argument);
      continue;
    }
    if (!CONNECT_VALUE_OPTIONS.has(argument)) {
      throw new ScannerError("UNKNOWN_OPTION", "An unknown connect option was supplied.", 2);
    }
    if (values.has(argument)) {
      throw new ScannerError("DUPLICATE_OPTION", `${argument} may be supplied only once.`, 2);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ScannerError("MISSING_OPTION_VALUE", `${argument} requires a value.`, 2);
    }
    values.set(argument, value);
    index += 1;
  }
  if (positionals.length !== 1) {
    throw new ScannerError("CONNECT_SESSION_REQUIRED", "connect requires exactly one upload session ID.", 2);
  }
  const uploadSessionId = positionals[0];
  const deviceCode = values.get("--code");
  if (!uploadSessionId || !deviceCode) {
    throw new ScannerError("CONNECT_CODE_REQUIRED", "connect requires --code <device-code>.", 2);
  }
  if (flags.has("--remote") && (values.has("--api-base-url") || values.has("--allow-host"))) {
    throw new ScannerError(
      "CONNECT_REMOTE_CONFLICT",
      "--remote is a shorthand for the hosted origin and cannot be combined with --api-base-url or --allow-host. Pass those directly instead of --remote for any other host.",
      2,
    );
  }
  const apiBaseUrl = flags.has("--remote")
    ? DEFAULT_REMOTE_API_BASE_URL
    : (values.get("--api-base-url") ?? process.env.BUILDSTORY_API_BASE_URL);
  const allowHost = flags.has("--remote") ? DEFAULT_REMOTE_HOST : values.get("--allow-host");
  const timeoutMilliseconds = parseTimeout(values.get("--timeout-ms"));
  return {
    command: "connect",
    uploadSessionId,
    deviceCode,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(allowHost ? { allowHost } : {}),
    ...(timeoutMilliseconds !== undefined ? { timeoutMilliseconds } : {}),
  };
}

function parseStatusArguments(argv: string[]): ParsedStatusArguments {
  if (argv.length === 1) return { command: "status" };
  if (argv.length !== 3 || argv[1] !== "--timeout-ms" || !argv[2]) {
    throw new ScannerError("STATUS_OPTION_INVALID", "status accepts only --timeout-ms <number>.", 2);
  }
  const timeoutMilliseconds = parseTimeout(argv[2]);
  return { command: "status", ...(timeoutMilliseconds !== undefined ? { timeoutMilliseconds } : {}) };
}

function parseScannerArguments(
  argv: string[],
  command: "inspect" | "scan" | "scan-upload",
): ParsedScannerArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (SCANNER_BOOLEAN_OPTIONS.has(argument)) {
      if (flags.has(argument)) throw new ScannerError("DUPLICATE_OPTION", `${argument} may be supplied only once.`, 2);
      flags.add(argument);
      continue;
    }
    if (!SCANNER_VALUE_OPTIONS.has(argument)) {
      throw new ScannerError("UNKNOWN_OPTION", "An unknown command-line option was supplied.", 2);
    }
    if (values.has(argument)) {
      throw new ScannerError("DUPLICATE_OPTION", `${argument} may be supplied only once.`, 2);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ScannerError("MISSING_OPTION_VALUE", `${argument} requires a value.`, 2);
    }
    values.set(argument, value);
    index += 1;
  }

  const repo = values.get("--repo");
  if (!repo) throw new ScannerError("REPOSITORY_REQUIRED", "--repo is required; use --repo . for the current repository.", 2);
  const rawSource = values.get("--source");
  const source =
    !rawSource || rawSource.trim() === "all"
      ? [...REGISTERED_PROVIDER_IDS]
      : rawSource.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  if (source.length === 0) {
    throw new ScannerError("UNSUPPORTED_PROVIDER", "--source must name at least one provider, or \"all\".", 2);
  }
  if (new Set(source).size !== source.length) {
    throw new ScannerError("DUPLICATE_OPTION", "--source lists the same provider more than once.", 2);
  }
  for (const provider of source) {
    if (!isRegisteredProvider(provider)) {
      throw new ScannerError(
        "UNSUPPORTED_PROVIDER",
        `--source does not support "${provider}"; use ${REGISTERED_PROVIDER_IDS.join(", ")}, "all", or a comma-separated list.`,
        2,
      );
    }
  }

  const common = {
    command,
    repo,
    source: source as ProviderId[],
    dryRun: flags.has("--dry-run"),
    overwrite: flags.has("--overwrite"),
    withEvidence: flags.has("--with-evidence"),
    review: flags.has("--review"),
    requireEvidence: flags.has("--require-evidence"),
    quiet: flags.has("--quiet"),
  } as const;
  const codexHome = values.get("--codex-home");
  const claudeCodeHome = values.get("--claude-code-home");
  const cursorHome = values.get("--cursor-home");
  const antigravityHome = values.get("--antigravity-home");
  const since = values.get("--since");
  const until = values.get("--until");
  const consent = values.get("--consent");
  const uploadConsent = values.get("--upload-consent");
  const output = values.get("--output");
  const projectName = values.get("--project-name");
  return {
    ...common,
    ...(codexHome ? { codexHome } : {}),
    ...(claudeCodeHome ? { claudeCodeHome } : {}),
    ...(cursorHome ? { cursorHome } : {}),
    ...(antigravityHome ? { antigravityHome } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(consent ? { consent } : {}),
    ...(uploadConsent ? { uploadConsent } : {}),
    ...(output ? { output } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

function parseArguments(argv: string[]): ParsedArguments | "help" | "version" {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") return "help";
  if (argv.includes("--version") || argv[0] === "version") return "version";
  const command = argv[0];
  if (command === "connect") return parseConnectArguments(argv);
  if (command === "status") return parseStatusArguments(argv);
  if (command === "inspect" || command === "scan" || command === "scan-upload") {
    return parseScannerArguments(argv, command);
  }
  throw new ScannerError("INVALID_COMMAND", "Expected connect, status, inspect, scan, or scan-upload.", 2);
}

function validateScannerArguments(args: ParsedScannerArguments): void {
  if (args.command === "inspect") {
    if (args.dryRun || args.output || args.overwrite || args.consent || args.uploadConsent || args.codexHome || args.claudeCodeHome || args.cursorHome || args.antigravityHome || args.since || args.until || args.withEvidence || args.review || args.requireEvidence || args.projectName) {
      throw new ScannerError("INSPECT_OPTION_INVALID", "inspect accepts only --repo, --source, and --quiet.", 2);
    }
    return;
  }

  if (args.consent !== "local-scan") {
    throw new ScannerError(
      "CONSENT_REQUIRED",
      `${args.command} requires --consent local-scan before any AI session source is read.`,
      2,
    );
  }

  if (args.withEvidence && !args.review) {
    throw new ScannerError(
      "EVIDENCE_REVIEW_REQUIRED",
      "--with-evidence requires --review so the exact excerpts are shown and confirmed before they leave this process.",
      2,
    );
  }
  // In local mode --review previews generated prose, so it is intentionally
  // valid without --with-evidence. The effective connection mode is resolved
  // after parsing; cloud evidence still requires --with-evidence below.
  if (args.requireEvidence && !args.withEvidence) {
    throw new ScannerError("REQUIRE_EVIDENCE_WITHOUT_EVIDENCE", "--require-evidence requires --with-evidence.", 2);
  }

  if (args.command === "scan") {
    if (args.uploadConsent) {
      throw new ScannerError("UPLOAD_CONSENT_WITHOUT_UPLOAD", "--upload-consent is accepted only by scan-upload.", 2);
    }
    if (args.dryRun === Boolean(args.output)) {
      throw new ScannerError("OUTPUT_MODE_REQUIRED", "Choose exactly one of --dry-run or --output <file>.", 2);
    }
    if (args.overwrite && !args.output) {
      throw new ScannerError("OVERWRITE_WITHOUT_OUTPUT", "--overwrite requires --output <file>.", 2);
    }
    return;
  }

  if (args.uploadConsent !== "local-dashboard") {
    throw new ScannerError(
      "UPLOAD_CONSENT_REQUIRED",
      "scan-upload requires --upload-consent local-dashboard for this validated snapshot.",
      2,
    );
  }
  if (args.dryRun || args.output || args.overwrite) {
    throw new ScannerError("UPLOAD_OUTPUT_MODE_INVALID", "scan-upload does not accept --dry-run, --output, or --overwrite.", 2);
  }
}

type EffectiveNarrative = { mode: "local" | "cloud" | "off"; model: string | null };

const PROGRESS_STAGE_LABELS: Record<ScanProgressEvent["stage"], string> = {
  "inspect-repository": "Inspecting repository",
  "discovering-providers": "Discovering providers",
  "parsing-sessions": "Parsing sessions",
  "aggregating-metrics": "Aggregating Git and usage",
  "selecting-evidence": "Selecting/redacting evidence",
  "resolving-model": "Resolving model",
  "generating-story": "Generating story components (1/2)",
  "generating-insights": "Generating insight components (2/2)",
  "validating-story-pack": "Validating story pack",
  uploading: "Uploading",
  accepted: "Accepted",
  failed: "Failed",
};

function createProgressReporter(quiet: boolean): { reporter: ScanProgressReporter; stop: () => void } {
  if (quiet) return { reporter: () => undefined, stop: () => undefined };
  const startedAt = Date.now();
  const isTty = Boolean(process.stderr.isTTY);
  let current: ScanProgressEvent | null = null;
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const elapsed = () => `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
  const render = () => {
    if (stopped || !current) return;
    const provider = current.provider ? ` · ${current.provider}` : "";
    const model = current.model ? ` · ${current.model}` : "";
    const count = current.current !== undefined && current.total !== undefined ? ` · ${current.current}/${current.total}` : "";
    const prefix = isTty ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame % 10] : "•";
    const line = `${prefix} ${PROGRESS_STAGE_LABELS[current.stage]}${provider}${model}${count} · ${elapsed()} — ${current.message}`;
    if (isTty) process.stderr.write(`\r\x1b[2K${line}`);
    else process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);
    frame += 1;
  };
  const reporter: ScanProgressReporter = (event) => {
    if (stopped) return;
    current = event;
    if (isTty) {
      if (!interval) interval = setInterval(render, 120);
      render();
    } else {
      render();
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    interval = undefined;
    if (isTty) process.stderr.write("\r\x1b[2K");
    else if (current) process.stderr.write("\n");
  };
  return { reporter, stop };
}

async function effectiveNarrative(parsed: ParsedScannerArguments): Promise<EffectiveNarrative> {
  if (parsed.withEvidence) return { mode: "cloud", model: null };
  if (parsed.command === "scan-upload") {
    const grant = await getStoredUploadGrant();
    if (grant?.narrative) return grant.narrative;
    // A grant written by an old CLI has no mode block. Preserve its historical behavior.
    return { mode: "cloud", model: null };
  }
  return { mode: "local", model: null };
}

function scanOptions(parsed: ParsedScannerArguments, narrative: EffectiveNarrative, onProgress?: ScanProgressReporter) {
  const local = narrative.mode === "local";
  const cloudEvidence = narrative.mode === "cloud" && parsed.withEvidence;
  return {
    repositoryPath: parsed.repo,
    ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
    consent: "local-scan" as const,
    providers: parsed.source,
    ...(parsed.codexHome ? { codexHome: parsed.codexHome } : {}),
    ...(parsed.claudeCodeHome ? { claudeCodeHome: parsed.claudeCodeHome } : {}),
    ...(parsed.cursorHome ? { cursorHome: parsed.cursorHome } : {}),
    ...(parsed.antigravityHome ? { antigravityHome: parsed.antigravityHome } : {}),
    ...(parsed.since ? { since: parsed.since } : {}),
    ...(parsed.until ? { until: parsed.until } : {}),
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    ...(cloudEvidence
      ? { narrative: { mode: "cloud" as const, model: null }, narrativeEvidence: {} }
      : narrative.mode === "local" || narrative.mode === "off"
        ? { narrative: { mode: narrative.mode, model: narrative.model } }
        : {}),
    ...(local ? { narrativeGenerator: createOllamaNarrativeGenerator(narrative.model) } : {}),
    ...(onProgress ? { onProgress } : {}),
  };
}

function metricsOnlyOptions(parsed: ParsedScannerArguments, onProgress?: ScanProgressReporter) {
  return scanOptions(parsed, { mode: "off", model: null }, onProgress);
}

interface ReviewableSnapshot {
  sourceSelection: { providers: Array<{ provider: ProviderId; sessionsMatched: number; diagnostic?: string }> };
  sessions: Array<{ sessionRef: string; provider: ProviderId }>;
  narrativeEvidence?: {
    excerpts: Array<{ role: string; sessionRef: string; occurredAt: string; text: string }>;
    discarded: { candidates: number; rejectedByRedaction: number; rejectedByBudget: number };
  };
  generatedNarrative?: {
    provider: string;
    model: string;
    fallbacksUsed: string[];
    sections: {
      headline: string;
      narrative: string;
      turningPoint: string;
      learnings: string[];
      decisionPatterns: string[];
      standoutTraits: string[];
      growthEdge: string;
    };
  };
}

function hasEvidence(snapshot: Pick<ReviewableSnapshot, "narrativeEvidence">): boolean {
  return Boolean(snapshot.narrativeEvidence && snapshot.narrativeEvidence.excerpts.length > 0);
}

function printEvidenceForReview(snapshot: ReviewableSnapshot): void {
  const sessionProvider = new Map(snapshot.sessions.map((session) => [session.sessionRef, session.provider]));
  const excerptCountByProvider = new Map<ProviderId, number>();
  for (const excerpt of snapshot.narrativeEvidence?.excerpts ?? []) {
    const provider = sessionProvider.get(excerpt.sessionRef);
    if (provider) excerptCountByProvider.set(provider, (excerptCountByProvider.get(provider) ?? 0) + 1);
  }

  process.stdout.write("Providers considered for narrative evidence:\n");
  for (const selection of snapshot.sourceSelection.providers) {
    const excerptCount = excerptCountByProvider.get(selection.provider) ?? 0;
    const diagnosticSuffix = selection.diagnostic && selection.diagnostic !== "scanned" ? ` (${selection.diagnostic})` : "";
    process.stdout.write(
      `  ${providerLabel(selection.provider)}: ${selection.sessionsMatched} session${selection.sessionsMatched === 1 ? "" : "s"}, ${excerptCount} excerpt${excerptCount === 1 ? "" : "s"} selected${diagnosticSuffix}\n`,
    );
  }
  process.stdout.write("\n");

  const bundle = snapshot.narrativeEvidence;
  if (!bundle || bundle.excerpts.length === 0) {
    process.stdout.write("No excerpts were selected for this scan; no LLM request will be made if you continue.\n\n");
    return;
  }
  process.stdout.write(
    `The following ${bundle.excerpts.length} redacted excerpt${bundle.excerpts.length === 1 ? "" : "s"} would be sent to the configured cloud model if you continue:\n\n`,
  );
  for (const excerpt of bundle.excerpts) {
    const provider = sessionProvider.get(excerpt.sessionRef);
    process.stdout.write(`--- ${provider ? `[${provider}] ` : ""}[${excerpt.role}] ${excerpt.sessionRef} @ ${excerpt.occurredAt} ---\n${excerpt.text}\n\n`);
  }
  process.stdout.write(
    `(${bundle.discarded.candidates} candidate${bundle.discarded.candidates === 1 ? "" : "s"} considered; ${bundle.discarded.rejectedByRedaction} dropped by redaction, ${bundle.discarded.rejectedByBudget} dropped by budget.)\n\n`,
  );
}

function printLocalNarrativeForReview(snapshot: ReviewableSnapshot): void {
  const narrative = snapshot.generatedNarrative;
  if (!narrative) {
    process.stdout.write("Local narrative generation produced no prose; only the deterministic metrics will be uploaded.\n\n");
    return;
  }
  process.stdout.write(`Local narrative generated by ${narrative.provider} (${narrative.model}). No excerpts will be uploaded in local mode.\n\n`);
  process.stdout.write(`HEADLINE\n${narrative.sections.headline}\n\nNARRATIVE\n${narrative.sections.narrative}\n\nTURNING POINT\n${narrative.sections.turningPoint}\n\n`);
  process.stdout.write(`LEARNINGS\n${narrative.sections.learnings.map((item) => `- ${item}`).join("\n")}\n\n`);
  process.stdout.write(`DECISION PATTERNS\n${narrative.sections.decisionPatterns.map((item) => `- ${item}`).join("\n")}\n\n`);
  process.stdout.write(`STANDOUT TRAITS\n${narrative.sections.standoutTraits.map((item) => `- ${item}`).join("\n")}\n\nGROWTH EDGE\n${narrative.sections.growthEdge}\n\n`);
  if (narrative.fallbacksUsed.length) process.stdout.write(`Deterministic fallbacks used: ${narrative.fallbacksUsed.join(", ")}.\n\n`);
}

export function isPromptCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return error.name === "AbortError"
    || code === "ABORT_ERR"
    || code === "ERR_USE_AFTER_CLOSE"
    || /readline was closed/i.test(error.message);
}

export async function confirmProceed(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  process.once("SIGINT", handleInterrupt);
  try {
    const answer = await rl.question(`${prompt} Type "yes" to continue: `, { signal: controller.signal });
    return answer.trim().toLowerCase() === "yes";
  } catch (error) {
    if (controller.signal.aborted || isPromptCancellation(error)) {
      process.stdout.write("\n");
      throw new ScannerError("CANCELLED", "Cancelled. No snapshot was written or uploaded.", 130);
    }
    throw error;
  } finally {
    process.off("SIGINT", handleInterrupt);
    rl.close();
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed === "version") {
    process.stdout.write(`${SCANNER_VERSION}\n`);
    return 0;
  }
  if (parsed.command === "connect") {
    const receipt = await connectBuildStory({
      uploadSessionId: parsed.uploadSessionId,
      deviceCode: parsed.deviceCode,
      ...(parsed.apiBaseUrl ? { apiBaseUrl: parsed.apiBaseUrl } : {}),
      ...(parsed.allowHost ? { allowHost: parsed.allowHost } : {}),
      ...(parsed.timeoutMilliseconds !== undefined ? { timeoutMilliseconds: parsed.timeoutMilliseconds } : {}),
    });
    if (receipt.mode === "mock") {
      process.stdout.write(
        "BuildStory mock connection accepted locally. No network request was made, no dashboard was contacted, no upload grant was created, and no snapshot was uploaded.\n",
      );
    } else {
      process.stdout.write(
        `Local dashboard connection accepted. A short-lived one-PUT grant is stored until ${receipt.grantExpiresAt}. No repository was read and no snapshot was uploaded.\n`,
      );
    }
    return 0;
  }
  if (parsed.command === "status") {
    const result = await readLocalDashboardStatus({
      ...(parsed.timeoutMilliseconds !== undefined ? { timeoutMilliseconds: parsed.timeoutMilliseconds } : {}),
    });
    if (result.source === "local") {
      if (result.connection.state === "none") {
        process.stdout.write("No local dashboard connection is stored. Start the local web app and run buildstory-scan connect.\n");
      } else if (result.connection.state === "ready") {
        process.stdout.write(`A one-PUT local dashboard grant is ready until ${result.connection.expiresAt}. No snapshot has been uploaded with it.\n`);
      } else if (result.connection.state === "expired") {
        process.stdout.write("The local dashboard credential expired. Run buildstory-scan connect with a fresh dashboard code.\n");
      } else {
        process.stdout.write("A snapshot was uploaded, but its read-only dashboard status is unavailable.\n");
      }
      return 0;
    }
    process.stdout.write(`Local dashboard lifecycle: ${result.lifecycle}. Report: ${result.reportReady ? "ready" : "pending"}.\n`);
    if (result.report) {
      process.stdout.write(`${result.report.summary}\n`);
      process.stdout.write(
        `Safe aggregates: ${result.report.sessionCount} sessions, ${result.report.commitCount} commits, ${result.report.milestoneCount} milestones, ${result.report.warningCount} warnings.\n`,
      );
    }
    return 0;
  }

  validateScannerArguments(parsed);
  if (parsed.command === "inspect") {
    const report = await inspectSelectedRepository(parsed.repo);
    // `--quiet` controls progress, never machine-readable command data.
    process.stdout.write(canonicalJson(report));
    return 0;
  }

  let activeNarrative = await effectiveNarrative(parsed);
  if (activeNarrative.mode === "local" && parsed.withEvidence) {
    throw new ScannerError("NARRATIVE_MODE_CONFLICT", "This connection is in local mode. Local generation never uploads excerpts; choose cloud mode in the dashboard before using --with-evidence.", 2);
  }
  if (activeNarrative.mode === "local" && parsed.requireEvidence) {
    throw new ScannerError("REQUIRE_EVIDENCE_WITH_LOCAL", "--require-evidence applies only to cloud excerpt mode; local mode generates prose on this machine.", 2);
  }

  let progress = createProgressReporter(parsed.quiet);
  let snapshot;
  try {
    try {
      snapshot = await buildProjectSnapshot(scanOptions(parsed, activeNarrative, progress.reporter));
    } catch (error) {
      if (!(activeNarrative.mode === "local" && error instanceof LocalNarrativeGenerationError)) throw error;
      progress.reporter({ stage: "failed", state: "failed", message: error.message });
      progress.stop();
      const canPrompt = Boolean(process.stdin.isTTY) && !parsed.quiet;
      if (canPrompt) {
        process.stdout.write(`Local narrative generation failed: ${error.message}\n`);
        const switchToCloud = await confirmProceed("Switch to cloud mode? This will select and upload redacted excerpts");
        progress = createProgressReporter(parsed.quiet);
        if (switchToCloud) {
          activeNarrative = { mode: "cloud", model: null };
          snapshot = await buildProjectSnapshot(scanOptions({ ...parsed, withEvidence: true, review: true }, { mode: "cloud", model: null }, progress.reporter));
        } else {
          activeNarrative = { mode: "off", model: null };
          snapshot = await buildProjectSnapshot(metricsOnlyOptions(parsed, progress.reporter));
        }
      } else {
        progress = createProgressReporter(parsed.quiet);
        activeNarrative = { mode: "off", model: null };
        snapshot = await buildProjectSnapshot(metricsOnlyOptions(parsed, progress.reporter));
      }
    }
    progress.stop();
  if (parsed.requireEvidence && !hasEvidence(snapshot)) {
    printEvidenceForReview(snapshot);
    process.stdout.write("metrics-only: no narrative evidence was found. --require-evidence is set, so nothing was written or uploaded.\n");
    return 4;
  }
  if (parsed.review) {
    if (activeNarrative.mode === "local" && snapshot.generatedNarrative) printLocalNarrativeForReview(snapshot);
    else printEvidenceForReview(snapshot);
    const confirmed = await confirmProceed(
      parsed.command === "scan-upload"
        ? activeNarrative.mode === "local"
          ? "This will upload the generated local narrative and deterministic metrics. No conversation excerpts will leave this machine."
          : "This will be sent to your configured Buildstory dashboard along with the rest of the snapshot."
        : "This will be included in the written snapshot file.",
    );
    if (!confirmed) {
      process.stdout.write("Not confirmed. No snapshot was written or uploaded.\n");
      return 3;
    }
  }
  if (parsed.command === "scan-upload") {
    progress = createProgressReporter(parsed.quiet);
    progress.reporter({ stage: "uploading", state: "start", message: "Uploading the validated snapshot." });
    const receipt = await uploadProjectSnapshot(snapshot);
    progress.reporter({ stage: "accepted", state: "complete", message: "Dashboard accepted the snapshot." });
    progress.stop();
    if (!parsed.quiet) {
      process.stdout.write(
        `Validated and uploaded ProjectSnapshot ${snapshot.schemaVersion}: ${receipt.payloadBytes} bytes, ${snapshot.sessions.length} sessions, ${snapshot.git.commits} commits, ${snapshot.quality.warningCount} warnings${usageSummarySuffix(snapshot)}.\n`,
      );
      process.stdout.write(
        "Local dashboard accepted the one-PUT snapshot. Run buildstory-scan status for authenticated read-only status/report updates until the credential expires.\n",
      );
    }
    return 0;
  }

  if (parsed.dryRun) {
    process.stdout.write(canonicalJson(snapshot));
    return 0;
  }

  const repository = await inspectRepository(parsed.repo, new Redactor());
  const writtenPath = await writeSnapshotFile(snapshot, {
    outputPath: path.resolve(parsed.output as string),
    repositoryRoot: repository.rootPath,
    overwrite: parsed.overwrite,
  });
  if (!parsed.quiet) {
    process.stdout.write(`Wrote ${snapshot.schemaVersion} snapshot ${snapshot.scanId} to ${writtenPath}${usageSummarySuffix(snapshot)}\n`);
  }
  return 0;
  } catch (error) {
    progress.reporter({ stage: "failed", state: "failed", message: safeErrorMessage(error) });
    throw error;
  } finally {
    progress.stop();
  }
}

// realpathSync, not path.resolve: npm's POSIX bin-linking installs a real
// symlink (node_modules/.bin/buildstory-scan -> ../buildstory-scan/dist/src/cli.js),
// and on Linux, Node's ESM loader sets import.meta.url of an entry module to
// its REALPATH, while process.argv[1] stays the symlink path the shell
// actually invoked. path.resolve() normalizes but does not follow symlinks, so
// the two never matched and this branch silently never ran - confirmed via a
// Docker repro (node:22-bookworm): exit 0, zero output, every time. Windows
// never hit this because npm creates .cmd/.ps1 wrappers there instead of a
// symlink, which is exactly why 149 local (Windows) test runs never caught it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
      process.exitCode = error instanceof ScannerError ? error.exitCode : 1;
    },
  );
}
