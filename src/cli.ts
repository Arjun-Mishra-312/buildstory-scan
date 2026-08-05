#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./canonical-json.js";
import { connectBuildStory } from "./connect.js";
import type { ProviderId } from "./contract.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, SCANNER_VERSION } from "./contract.js";
import { ScannerError, safeErrorMessage } from "./errors.js";
import { readLocalDashboardStatus, uploadProjectSnapshot } from "./local-upload.js";
import { writeSnapshotFile } from "./output.js";
import { Redactor } from "./redaction.js";
import { inspectRepository } from "./repository.js";
import { buildProjectSnapshot, inspectSelectedRepository } from "./scanner.js";

/** The canonical hosted origin --remote expands to; kept separate from user input so it is never itself an injectable value. */
const DEFAULT_REMOTE_API_BASE_URL = "https://buildstory.dev/";
const DEFAULT_REMOTE_HOST = "buildstory.dev";

const HELP = `BuildStory CLI ${SCANNER_VERSION}

Read-only local scanner. ProjectSnapshot transport is loopback by default, or
a single explicitly pinned HTTPS remote host per connection.

Usage:
  buildstory connect <upload-session-id> --code <device-code> --api-base-url <loopback-url>
  buildstory connect <upload-session-id> --code <device-code> --remote
  buildstory connect <upload-session-id> --code <device-code> --api-base-url <https-url> --allow-host <hostname>
  buildstory status [--timeout-ms <number>]
  buildstory inspect --repo <directory>
  buildstory scan --repo <directory> --consent local-scan --dry-run
  buildstory scan --repo <directory> --consent local-scan --output <file> [--overwrite]
  buildstory scan-upload --repo <directory> --consent local-scan --upload-consent local-dashboard

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
  --source <list>            Comma-separated providers to scan: codex, claude-code
                             (default: every supported provider).
  --codex-home <directory>   Override the Codex session root.
  --claude-code-home <directory>
                             Override the Claude Code config directory (parent of "projects").
  --since <ISO-8601>         Inclusive activity-window start.
  --until <ISO-8601>         Inclusive activity-window end.
  --consent local-scan       Allow local repository/session metadata reads.
  --upload-consent local-dashboard
                             Separately allow this validated snapshot to the connected loopback dashboard.
  --dry-run                  Validate and print the redacted snapshot; write no file.
  --output <file>            Atomically write outside the selected repository.
  --overwrite                Replace an existing regular output file.
  --with-evidence            Opt in to a small, redacted set of conversation
                             excerpts (narrativeEvidence) for AI narrative
                             generation. Off by default. Requires --review.
  --review                   Print the exact excerpts to be included and
                             require typed confirmation before proceeding.
                             Required whenever --with-evidence is set.
  --quiet                    Suppress command success output.
  --help                     Show this help.
  --version                  Show the scanner version.

connect never scans or uploads. scan never uses the network. scan-upload is the
only snapshot network path, and only ever talks to the single endpoint pinned
during the preceding connect (loopback, or the one --allow-host/--remote host).
It sends exactly one canonical, schema-validated ProjectSnapshot ${PROJECT_SNAPSHOT_SCHEMA_VERSION}
using a short-lived, one-use grant. Browser cookies, redirects, unpinned hosts,
source/file bodies, diffs, transcript bodies, tool arguments/results, file
paths, and secret text are not sent.

--with-evidence is the one exception: with explicit --review confirmation, a
bounded set of redacted conversation excerpts (narrativeEvidence) is included
so a narrative can be generated from them. Every other field always stays
content-free regardless of this flag.
`;

interface ParsedScannerArguments {
  command: "inspect" | "scan" | "scan-upload";
  repo: string;
  source: ProviderId[];
  codexHome?: string;
  claudeCodeHome?: string;
  since?: string;
  until?: string;
  consent?: string;
  uploadConsent?: string;
  dryRun: boolean;
  output?: string;
  overwrite: boolean;
  withEvidence: boolean;
  review: boolean;
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
  "--source",
  "--codex-home",
  "--claude-code-home",
  "--since",
  "--until",
  "--consent",
  "--upload-consent",
  "--output",
]);
const KNOWN_PROVIDERS: ReadonlySet<ProviderId> = new Set(["codex", "claude-code"]);
const SCANNER_BOOLEAN_OPTIONS = new Set(["--dry-run", "--overwrite", "--quiet", "--with-evidence", "--review"]);
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
  const source = rawSource
    ? rawSource.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
    : [...KNOWN_PROVIDERS];
  if (source.length === 0) {
    throw new ScannerError("UNSUPPORTED_PROVIDER", "--source must name at least one provider.", 2);
  }
  if (new Set(source).size !== source.length) {
    throw new ScannerError("DUPLICATE_OPTION", "--source lists the same provider more than once.", 2);
  }
  for (const provider of source) {
    if (!KNOWN_PROVIDERS.has(provider as ProviderId)) {
      throw new ScannerError(
        "UNSUPPORTED_PROVIDER",
        `--source does not support "${provider}"; use codex, claude-code, or a comma-separated list of both.`,
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
    quiet: flags.has("--quiet"),
  } as const;
  const codexHome = values.get("--codex-home");
  const claudeCodeHome = values.get("--claude-code-home");
  const since = values.get("--since");
  const until = values.get("--until");
  const consent = values.get("--consent");
  const uploadConsent = values.get("--upload-consent");
  const output = values.get("--output");
  return {
    ...common,
    ...(codexHome ? { codexHome } : {}),
    ...(claudeCodeHome ? { claudeCodeHome } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(consent ? { consent } : {}),
    ...(uploadConsent ? { uploadConsent } : {}),
    ...(output ? { output } : {}),
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
    if (args.dryRun || args.output || args.overwrite || args.consent || args.uploadConsent || args.codexHome || args.claudeCodeHome || args.since || args.until || args.withEvidence || args.review) {
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
  if (args.review && !args.withEvidence) {
    throw new ScannerError("REVIEW_WITHOUT_EVIDENCE", "--review is only meaningful together with --with-evidence.", 2);
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

function scanOptions(parsed: ParsedScannerArguments) {
  return {
    repositoryPath: parsed.repo,
    consent: "local-scan" as const,
    providers: parsed.source,
    ...(parsed.codexHome ? { codexHome: parsed.codexHome } : {}),
    ...(parsed.claudeCodeHome ? { claudeCodeHome: parsed.claudeCodeHome } : {}),
    ...(parsed.since ? { since: parsed.since } : {}),
    ...(parsed.until ? { until: parsed.until } : {}),
    ...(parsed.withEvidence ? { narrativeEvidence: {} } : {}),
  };
}

function printEvidenceForReview(snapshot: { narrativeEvidence?: { excerpts: Array<{ role: string; sessionRef: string; occurredAt: string; text: string }>; discarded: { candidates: number; rejectedByRedaction: number; rejectedByBudget: number } } }): void {
  const bundle = snapshot.narrativeEvidence;
  if (!bundle) {
    process.stdout.write("No excerpts were selected for this scan; the evidence bundle would be empty.\n\n");
    return;
  }
  process.stdout.write(
    `The following ${bundle.excerpts.length} redacted excerpt${bundle.excerpts.length === 1 ? "" : "s"} would be sent to the configured cloud model if you continue:\n\n`,
  );
  for (const excerpt of bundle.excerpts) {
    process.stdout.write(`--- [${excerpt.role}] ${excerpt.sessionRef} @ ${excerpt.occurredAt} ---\n${excerpt.text}\n\n`);
  }
  process.stdout.write(
    `(${bundle.discarded.candidates} candidate${bundle.discarded.candidates === 1 ? "" : "s"} considered; ${bundle.discarded.rejectedByRedaction} dropped by redaction, ${bundle.discarded.rejectedByBudget} dropped by budget.)\n\n`,
  );
}

async function confirmProceed(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${prompt} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
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
        process.stdout.write("No local dashboard connection is stored. Start the local web app and run buildstory connect.\n");
      } else if (result.connection.state === "ready") {
        process.stdout.write(`A one-PUT local dashboard grant is ready until ${result.connection.expiresAt}. No snapshot has been uploaded with it.\n`);
      } else if (result.connection.state === "expired") {
        process.stdout.write("The local dashboard credential expired. Run buildstory connect with a fresh dashboard code.\n");
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
    if (!parsed.quiet) process.stdout.write(canonicalJson(report));
    return 0;
  }

  const snapshot = await buildProjectSnapshot(scanOptions(parsed));
  if (parsed.review) {
    printEvidenceForReview(snapshot);
    const confirmed = await confirmProceed(
      parsed.command === "scan-upload"
        ? "This will be sent to your configured Buildstory dashboard along with the rest of the snapshot."
        : "This will be included in the written snapshot file.",
    );
    if (!confirmed) {
      process.stdout.write("Not confirmed. No snapshot was written or uploaded.\n");
      return 3;
    }
  }
  if (parsed.command === "scan-upload") {
    const receipt = await uploadProjectSnapshot(snapshot);
    if (!parsed.quiet) {
      process.stdout.write(
        `Validated and uploaded ProjectSnapshot ${snapshot.schemaVersion}: ${receipt.payloadBytes} bytes, ${snapshot.sessions.length} sessions, ${snapshot.git.commits} commits, ${snapshot.quality.warningCount} warnings.\n`,
      );
      process.stdout.write(
        "Local dashboard accepted the one-PUT snapshot. Run buildstory status for authenticated read-only status/report updates until the credential expires.\n",
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
    process.stdout.write(`Wrote ${snapshot.schemaVersion} snapshot ${snapshot.scanId} to ${writtenPath}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
