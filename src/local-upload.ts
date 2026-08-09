import {
  consumeUploadGrant,
  getConnectionStatus,
  getStoredStatusAccess,
  storeStatusAccess,
  type ConnectionStatus,
  type StoredStatusAccess,
} from "./connection-state.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import { CONNECT_PROTOCOL_VERSION, MAX_SNAPSHOT_UPLOAD_BYTES } from "./connect.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, type ProjectSnapshot } from "./contract.js";
import { ScannerError } from "./errors.js";
import { resolveTrustedApiUrl } from "./loopback-url.js";
import { detectKnownSecrets, Redactor } from "./redaction.js";
import { detectPrivateLocations } from "./privacy-boundary.js";
import { validateProjectSnapshot } from "./validation.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const FORBIDDEN_CONTENT_KEYS = new Set([
  "host",
  "cwd",
  "filePath",
  "absolutePath",
  "sourceText",
  "fileBody",
  "diff",
  "patch",
  "prompt",
  "transcript",
  "toolArguments",
  "toolResults",
  "remoteUrl",
]);

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UploadProjectSnapshotOptions {
  stateDirectory?: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: FetchImplementation;
  now?: Date;
}

export interface LocalUploadReceipt {
  accepted: true;
  scanId: ProjectSnapshot["scanId"];
  snapshotDigest: `sha256:${string}`;
  payloadBytes: number;
  statusAccessStored: true;
}

export interface SafeReportSummary {
  summary: string;
  sessionCount: number;
  commitCount: number;
  milestoneCount: number;
  warningCount: number;
}

export type LocalStatusResult =
  | { source: "local"; connection: ConnectionStatus }
  | {
      source: "dashboard";
      connection: ConnectionStatus;
      lifecycle: "accepted" | "processing" | "ready" | "failed";
      reportReady: boolean;
      narrativeStatus: "not_requested" | "queued" | "generating" | "ready" | "failed" | null;
      report: SafeReportSummary | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validateTimeout(value: number | undefined): number {
  const timeoutMilliseconds = value ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 60_000) {
    throw new ScannerError("UPLOAD_TIMEOUT_INVALID", "The local API timeout must be between 100 and 60000 milliseconds.", 2);
  }
  return timeoutMilliseconds;
}

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) assertNoForbiddenKeys(child);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key)) {
      throw new ScannerError("SNAPSHOT_PRIVACY_BOUNDARY_FAILED", "The validated snapshot contained a forbidden content-bearing field.");
    }
    assertNoForbiddenKeys(child);
  }
}

function buildValidatedPayload(snapshot: ProjectSnapshot): { body: string; bytes: Buffer; digest: `sha256:${string}` } {
  validateProjectSnapshot(snapshot);
  assertNoForbiddenKeys(snapshot);
  const serialized = canonicalJson(snapshot);
  if (detectKnownSecrets(serialized).length > 0) {
    throw new ScannerError("SNAPSHOT_SECRET_DETECTED", "A possible secret remained at the upload boundary; nothing was sent.");
  }
  if (detectPrivateLocations(snapshot).length > 0) {
    throw new ScannerError("SNAPSHOT_PRIVATE_LOCATION_DETECTED", "A possible URL, host, or path remained at the upload boundary; nothing was sent.");
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_SNAPSHOT_UPLOAD_BYTES) {
    throw new ScannerError("SNAPSHOT_TOO_LARGE", "The validated snapshot exceeds the scanner's 8 MiB local upload safety limit.");
  }
  return { body: serialized, bytes, digest: sha256(bytes) };
}

async function readBoundedJson(response: Response, errorPrefix: string): Promise<unknown> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScannerError(`${errorPrefix}_TOO_LARGE`, "The local API response exceeded the 64 KiB safety limit.");
  }
  if (!response.body) throw new ScannerError(`${errorPrefix}_INVALID`, "The local API returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ScannerError(`${errorPrefix}_TOO_LARGE`, "The local API response exceeded the 64 KiB safety limit.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw new ScannerError(`${errorPrefix}_INVALID`, "The local API returned invalid JSON.");
  }
}

function resolveReadUrl(rawValue: unknown, uploadUrl: URL, required: boolean): URL | null {
  if (rawValue === null && !required) return null;
  if (typeof rawValue !== "string") return null;
  const parsed = resolveTrustedApiUrl(rawValue, uploadUrl);
  if (!parsed || parsed.origin !== uploadUrl.origin) return null;
  return parsed;
}

function validateAcceptedResponse(
  value: unknown,
  snapshot: ProjectSnapshot,
  digest: `sha256:${string}`,
  uploadUrl: URL,
): { statusAccess: StoredStatusAccess } {
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "status", "receipt", "statusUrl", "reportUrl"])
    || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
    || value.status !== "accepted"
    || !isRecord(value.receipt)
    || !hasExactKeys(value.receipt, ["receiptId", "scanId", "snapshotDigest", "acceptedAt"])
    || typeof value.receipt.receiptId !== "string"
    || value.receipt.receiptId.length < 1
    || value.receipt.receiptId.length > 200
    || value.receipt.scanId !== snapshot.scanId
    || value.receipt.snapshotDigest !== digest
    || typeof value.receipt.acceptedAt !== "string"
    || !Number.isFinite(Date.parse(value.receipt.acceptedAt))) {
    throw new ScannerError(
      "UPLOAD_RESPONSE_INVALID",
      "The local API accepted bytes but returned an invalid receipt. The grant was consumed; check the dashboard before reconnecting.",
    );
  }
  const statusUrl = resolveReadUrl(value.statusUrl, uploadUrl, true);
  const reportUrl = resolveReadUrl(value.reportUrl, uploadUrl, false);
  if (!statusUrl || (value.reportUrl !== null && !reportUrl)) {
    throw new ScannerError(
      "UPLOAD_RESPONSE_INVALID",
      "The local API returned an unsafe status or report URL. The grant was consumed; check the dashboard before reconnecting.",
    );
  }
  return {
    statusAccess: {
      stateVersion: 1,
      phase: "uploaded",
      bearerToken: "",
      expiresAt: "",
      schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
      statusUrl: statusUrl.href,
      reportUrl: reportUrl?.href ?? null,
    },
  };
}

async function fetchWithTimeout(
  fetchImplementation: FetchImplementation,
  input: URL,
  init: RequestInit,
  timeoutMilliseconds: number,
  unavailableCode: string,
  unavailableMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    try {
      return await fetchImplementation(input, { ...init, signal: controller.signal });
    } catch {
      throw new ScannerError(unavailableCode, unavailableMessage);
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadProjectSnapshot(
  snapshot: ProjectSnapshot,
  options: UploadProjectSnapshotOptions = {},
): Promise<LocalUploadReceipt> {
  const payload = buildValidatedPayload(snapshot);
  const localState = await getConnectionStatus(options.stateDirectory, options.now ?? new Date());
  if (localState.state === "ready" && localState.maxBytes !== undefined && payload.bytes.byteLength > localState.maxBytes) {
    throw new ScannerError("SNAPSHOT_TOO_LARGE_FOR_GRANT", "The validated snapshot exceeds the dashboard grant's byte limit; nothing was sent.");
  }

  const lease = await consumeUploadGrant(options.stateDirectory, options.now ?? new Date());
  const grant = lease.grant;
  if (payload.bytes.byteLength > grant.maxBytes) {
    await lease.release("retryable");
    throw new ScannerError("SNAPSHOT_TOO_LARGE_FOR_GRANT", "The validated snapshot exceeds the claimed grant's byte limit; nothing was sent. Connect again after reducing the scan window.");
  }
  const uploadUrl = resolveTrustedApiUrl(grant.snapshotEndpoint);
  if (!uploadUrl) {
    await lease.release("retryable");
    throw new ScannerError("UPLOAD_ENDPOINT_INVALID", "The claimed snapshot endpoint is unsafe. Nothing was sent; run connect again.");
  }

  const timeoutMilliseconds = validateTimeout(options.timeoutMilliseconds);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      options.fetchImplementation ?? globalThis.fetch,
      uploadUrl,
      {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${grant.bearerToken}`,
        "content-type": "application/json",
        "x-buildstory-schema-version": snapshot.schemaVersion,
        "x-buildstory-snapshot-digest": payload.digest,
      },
      body: payload.body,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      },
      timeoutMilliseconds,
      "UPLOAD_UNAVAILABLE",
      "The local dashboard upload endpoint is unavailable. The grant remains available for a retry.",
    );
  } catch (error) {
    await lease.release("retryable");
    throw error;
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
    await lease.release(retryable ? "retryable" : "terminal");
    await response.body?.cancel().catch(() => undefined);
    throw new ScannerError(
      "UPLOAD_REJECTED",
      `The local dashboard rejected the validated snapshot (HTTP ${response.status}).${retryable ? " The local grant remains available for a manual retry; the server may still refuse a grant it already accepted." : " The grant cannot be reused."}`,
    );
  }
  const responseValue = await readBoundedJson(response, "UPLOAD_RESPONSE");
  const accepted = validateAcceptedResponse(responseValue, snapshot, payload.digest, uploadUrl);
  accepted.statusAccess.bearerToken = grant.bearerToken;
  accepted.statusAccess.expiresAt = grant.expiresAt;
  await lease.release("success");
  try {
    await storeStatusAccess(accepted.statusAccess, options.stateDirectory);
  } catch {
    throw new ScannerError(
      "UPLOAD_ACCEPTED_STATUS_UNAVAILABLE",
      "The local dashboard accepted the snapshot, but status access could not be stored. Use the dashboard to view the result.",
    );
  }
  return {
    accepted: true,
    scanId: snapshot.scanId,
    snapshotDigest: payload.digest,
    payloadBytes: payload.bytes.byteLength,
    statusAccessStored: true,
  };
}

function authorizationHeaders(access: StoredStatusAccess): HeadersInit {
  return {
    accept: "application/json",
    authorization: `Bearer ${access.bearerToken}`,
  };
}

function validateStatusResponse(value: unknown): {
  lifecycle: "accepted" | "processing" | "ready" | "failed";
  reportReady: boolean;
  narrativeStatus: "not_requested" | "queued" | "generating" | "ready" | "failed" | null;
} {
  if (!isRecord(value)
    || !(hasExactKeys(value, ["protocolVersion", "status", "reportReady"])
      || hasExactKeys(value, ["protocolVersion", "status", "reportReady", "narrativeStatus"]))
    || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
    || !["accepted", "processing", "ready", "failed"].includes(value.status as string)
    || typeof value.reportReady !== "boolean"
    || ("narrativeStatus" in value && !["not_requested", "queued", "generating", "ready", "failed"].includes(value.narrativeStatus as string))) {
    throw new ScannerError("STATUS_RESPONSE_INVALID", "The local dashboard returned an invalid content-free status response.");
  }
  return {
    lifecycle: value.status as "accepted" | "processing" | "ready" | "failed",
    reportReady: value.reportReady,
    narrativeStatus: "narrativeStatus" in value
      ? value.narrativeStatus as "not_requested" | "queued" | "generating" | "ready" | "failed"
      : null,
  };
}

function nonNegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateReportResponse(value: unknown): SafeReportSummary {
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "status", "report"])
    || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
    || value.status !== "ready"
    || !isRecord(value.report)
    || !hasExactKeys(value.report, ["summary", "sessionCount", "commitCount", "milestoneCount", "warningCount"])
    || typeof value.report.summary !== "string"
    || value.report.summary.length < 1
    || value.report.summary.length > 2_000
    || !nonNegativeCount(value.report.sessionCount)
    || !nonNegativeCount(value.report.commitCount)
    || !nonNegativeCount(value.report.milestoneCount)
    || !nonNegativeCount(value.report.warningCount)) {
    throw new ScannerError("REPORT_RESPONSE_INVALID", "The local dashboard returned an invalid report summary.");
  }
  const redactor = new Redactor();
  const summary = redactor.cleanMetadata(value.report.summary, 500);
  if (detectKnownSecrets(summary).length > 0) {
    throw new ScannerError("REPORT_PRIVACY_BOUNDARY_FAILED", "The local dashboard report failed the terminal privacy check and was not displayed.");
  }
  return {
    summary,
    sessionCount: value.report.sessionCount,
    commitCount: value.report.commitCount,
    milestoneCount: value.report.milestoneCount,
    warningCount: value.report.warningCount,
  };
}

async function authenticatedGet(
  urlValue: string,
  access: StoredStatusAccess,
  options: UploadProjectSnapshotOptions,
  errorPrefix: string,
): Promise<unknown> {
  const url = resolveTrustedApiUrl(urlValue);
  if (!url) throw new ScannerError(`${errorPrefix}_ENDPOINT_INVALID`, "The stored local dashboard endpoint is unsafe. Run connect again.");
  const response = await fetchWithTimeout(
    options.fetchImplementation ?? globalThis.fetch,
    url,
    {
      method: "GET",
      headers: authorizationHeaders(access),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
    validateTimeout(options.timeoutMilliseconds),
    `${errorPrefix}_UNAVAILABLE`,
    "The dashboard is unavailable. Verify it is reachable at the connected API base and run status again.",
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ScannerError(`${errorPrefix}_REJECTED`, `The local dashboard rejected the read-only request (HTTP ${response.status}).`);
  }
  return readBoundedJson(response, `${errorPrefix}_RESPONSE`);
}

export async function readLocalDashboardStatus(options: UploadProjectSnapshotOptions = {}): Promise<LocalStatusResult> {
  const now = options.now ?? new Date();
  const connection = await getConnectionStatus(options.stateDirectory, now);
  if (connection.state !== "uploaded") return { source: "local", connection };
  const access = await getStoredStatusAccess(options.stateDirectory, now);
  if (!access) return { source: "local", connection: { state: "expired", expiresAt: connection.expiresAt, schemaVersion: connection.schemaVersion } };

  const status = validateStatusResponse(await authenticatedGet(access.statusUrl, access, options, "STATUS"));
  if (status.reportReady && (status.lifecycle !== "ready" || access.reportUrl === null)) {
    throw new ScannerError("STATUS_RESPONSE_INVALID", "The local dashboard reported a ready report without valid report access.");
  }
  let report: SafeReportSummary | null = null;
  if (status.reportReady && access.reportUrl) {
    report = validateReportResponse(await authenticatedGet(access.reportUrl, access, options, "REPORT"));
  }
  return {
    source: "dashboard",
    connection,
    lifecycle: status.lifecycle,
    reportReady: status.reportReady,
    narrativeStatus: status.narrativeStatus,
    report,
  };
}
