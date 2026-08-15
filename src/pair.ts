import { SCANNER_VERSION } from "./contract.js";
import { storeUploadGrant, type StoredUploadGrant } from "./connection-state.js";
import { CONNECT_PROTOCOL_VERSION, MAX_SNAPSHOT_UPLOAD_BYTES } from "./connect.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "./contract.js";
import { ScannerError } from "./errors.js";
import { isLoopbackHostname, normalizeApiBase, resolveTrustedApiUrl } from "./loopback-url.js";

const DEFAULT_REMOTE_API_BASE_URL = "https://buildstory.dev/";
const DEFAULT_REMOTE_HOST = "buildstory.dev";
const PAIR_START_PATH = "api/v1/cli/pair/start";
const PAIR_POLL_PATH = "api/v1/cli/pair/poll";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_GRANT_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PairStartResult = {
  pairingId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function resolvePairApiBase(): { baseUrl: URL; allowHost?: string } {
  const fromEnv = process.env.BUILDSTORY_API_BASE_URL?.trim();
  if (fromEnv) {
    const baseUrl = normalizeApiBase(fromEnv);
    if (!baseUrl) {
      throw new ScannerError("CONNECT_ENDPOINT_NOT_LOCAL", "BUILDSTORY_API_BASE_URL is not a usable API base.");
    }
    if (!isLoopbackHostname(baseUrl.hostname) && baseUrl.hostname.toLocaleLowerCase("en-US") !== DEFAULT_REMOTE_HOST) {
      throw new ScannerError("CONNECT_ALLOW_HOST_REQUIRED", "Pairing only uses loopback or buildstory.dev.");
    }
    return { baseUrl };
  }
  const baseUrl = normalizeApiBase(DEFAULT_REMOTE_API_BASE_URL);
  if (!baseUrl) throw new ScannerError("CONNECT_ENDPOINT_NOT_LOCAL", "Hosted pairing origin is invalid.");
  return { baseUrl, allowHost: DEFAULT_REMOTE_HOST };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ScannerError("PAIR_RESPONSE_INVALID", "The pairing API returned an empty response.");
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
      throw new ScannerError("PAIR_RESPONSE_TOO_LARGE", "The pairing API response exceeded the 64 KiB safety limit.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw new ScannerError("PAIR_RESPONSE_INVALID", "The pairing API returned invalid JSON.");
  }
}

export async function startPairing(options: {
  projectLabel?: string;
  narrativeMode?: "local" | "byok" | "off";
  fetchImplementation?: FetchImplementation;
  timeoutMilliseconds?: number;
} = {}): Promise<PairStartResult> {
  const { baseUrl } = resolvePairApiBase();
  const url = new URL(PAIR_START_PATH, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 8_000);
  try {
    const response = await (options.fetchImplementation ?? globalThis.fetch)(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-buildstory-client-version": SCANNER_VERSION,
      },
      body: JSON.stringify({
        protocolVersion: CONNECT_PROTOCOL_VERSION,
        client: { command: "buildstory", version: SCANNER_VERSION },
        projectLabel: options.projectLabel ?? "Local generate",
        narrativeMode: options.narrativeMode ?? "local",
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ScannerError("PAIR_REJECTED", `BuildStory rejected pairing (HTTP ${response.status}).`);
    }
    const value = await readBoundedJson(response);
    if (!isRecord(value)
      || !hasExactKeys(value, ["protocolVersion", "pairingId", "userCode", "verificationUrl", "expiresAt", "intervalSeconds"])
      || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
      || typeof value.pairingId !== "string"
      || typeof value.userCode !== "string"
      || typeof value.verificationUrl !== "string"
      || typeof value.expiresAt !== "string"
      || typeof value.intervalSeconds !== "number"
      || !Number.isSafeInteger(value.intervalSeconds)) {
      throw new ScannerError("PAIR_RESPONSE_INVALID", "The pairing API returned an invalid start payload.");
    }
    const verificationUrl = new URL(value.verificationUrl);
    if (verificationUrl.origin !== baseUrl.origin) {
      throw new ScannerError("PAIR_RESPONSE_INVALID", "The pairing URL was not on the connected origin.");
    }
    return {
      pairingId: value.pairingId,
      userCode: value.userCode,
      verificationUrl: verificationUrl.href,
      expiresAt: value.expiresAt,
      intervalSeconds: Math.min(5, Math.max(1, value.intervalSeconds)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseNarrative(value: Record<string, unknown>): NonNullable<StoredUploadGrant["narrative"]> {
  if (!isRecord(value.narrative)) {
    return { mode: "local", provider: "ollama", model: null, analysisTier: "standard" };
  }
  const narrative = value.narrative;
  const mode = narrative.mode === "byok" || narrative.mode === "off" || narrative.mode === "local" ? narrative.mode : "local";
  const provider = narrative.provider === "openai" || narrative.provider === "openrouter" || narrative.provider === "ollama" || narrative.provider === "openai-compatible"
    ? narrative.provider
    : mode === "local"
      ? "ollama"
      : null;
  return {
    mode,
    provider,
    model: typeof narrative.model === "string" ? narrative.model : null,
    analysisTier: narrative.analysisTier === "deep" ? "deep" : "standard",
  };
}

function parseGrantedPoll(value: unknown, baseUrl: URL, now: Date): StoredUploadGrant & { uploadSessionId: string } {
  if (!isRecord(value)
    || !(
      hasExactKeys(value, ["protocolVersion", "status", "uploadSessionId", "connectionId", "uploadGrant"])
      || hasExactKeys(value, ["protocolVersion", "status", "uploadSessionId", "connectionId", "uploadGrant", "narrative"])
    )
    || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
    || value.status !== "connected"
    || typeof value.uploadSessionId !== "string"
    || typeof value.connectionId !== "string"
    || !isRecord(value.uploadGrant)) {
    throw new ScannerError("PAIR_RESPONSE_INVALID", "The pairing API returned an invalid grant.");
  }
  const grant = value.uploadGrant;
  const expiresAt = typeof grant.expiresAt === "string" ? new Date(grant.expiresAt) : new Date(Number.NaN);
  const endpointUrl = typeof grant.snapshotEndpoint === "string"
    ? resolveTrustedApiUrl(grant.snapshotEndpoint, baseUrl)
    : null;
  if (!hasExactKeys(grant, ["bearerToken", "snapshotEndpoint", "expiresAt", "schemaVersion", "maxBytes"])
    || typeof grant.bearerToken !== "string"
    || grant.bearerToken.length < 16
    || !endpointUrl
    || endpointUrl.origin !== baseUrl.origin
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() > now.getTime() + MAX_GRANT_LIFETIME_MILLISECONDS
    || grant.schemaVersion !== PROJECT_SNAPSHOT_SCHEMA_VERSION
    || !Number.isSafeInteger(grant.maxBytes)
    || (grant.maxBytes as number) > MAX_SNAPSHOT_UPLOAD_BYTES) {
    throw new ScannerError("PAIR_GRANT_INVALID", "The pairing API returned an invalid upload grant.");
  }
  return {
    stateVersion: 1,
    phase: "ready",
    bearerToken: grant.bearerToken,
    snapshotEndpoint: endpointUrl.href,
    expiresAt: expiresAt.toISOString(),
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    maxBytes: grant.maxBytes as number,
    narrative: parseNarrative(value),
    uploadSessionId: value.uploadSessionId,
  };
}

export async function pollPairingUntilGranted(options: {
  pairingId: string;
  intervalSeconds: number;
  expiresAt: string;
  fetchImplementation?: FetchImplementation;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<StoredUploadGrant> {
  const { baseUrl } = resolvePairApiBase();
  const url = new URL(PAIR_POLL_PATH, baseUrl);
  const now = options.now ?? (() => new Date());
  const deadline = Date.parse(options.expiresAt);
  while (!options.signal?.aborted) {
    if (now().getTime() >= deadline) {
      throw new ScannerError("PAIR_EXPIRED", "The browser pairing expired before it was approved.");
    }
    const response = await (options.fetchImplementation ?? globalThis.fetch)(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-buildstory-client-version": SCANNER_VERSION,
      },
      body: JSON.stringify({ protocolVersion: CONNECT_PROTOCOL_VERSION, pairingId: options.pairingId }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
    } else if (response.ok) {
      const value = await readBoundedJson(response);
      const granted = parseGrantedPoll(value, baseUrl, now());
      const { uploadSessionId: _ignored, ...grant } = granted;
      void _ignored;
      await storeUploadGrant(grant);
      return grant;
    } else if (response.status === 410 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new ScannerError("PAIR_EXPIRED", "The browser pairing expired or was not found.");
    } else {
      await response.body?.cancel().catch(() => undefined);
      throw new ScannerError("PAIR_REJECTED", `Pairing poll failed (HTTP ${response.status}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalSeconds * 1_000));
  }
  throw new ScannerError("PAIR_CANCELLED", "Pairing was cancelled.");
}
