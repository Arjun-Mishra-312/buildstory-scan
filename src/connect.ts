import { storeUploadGrant, type StoredUploadGrant } from "./connection-state.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION, SCANNER_VERSION } from "./contract.js";
import { ScannerError } from "./errors.js";
import { isLoopbackHostname, normalizeApiBase, resolveTrustedApiUrl } from "./loopback-url.js";

export const CONNECT_PROTOCOL_VERSION = "1.0" as const;
export const MOCK_API_BASE_URL = "mock://local" as const;
export const CONNECT_PATH = "api/v1/cli/connect" as const;
export const MAX_SNAPSHOT_UPLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_GRANT_LIFETIME_MILLISECONDS = 60 * 60 * 1_000;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ConnectOptions {
  uploadSessionId: string;
  deviceCode: string;
  apiBaseUrl?: string;
  /**
   * Required whenever apiBaseUrl resolves to a non-loopback host. The user
   * must state the exact hostname they intend to trust as a second,
   * separate argument - copying a malicious --api-base-url alone is not
   * enough to send the bearer grant anywhere.
   */
  allowHost?: string;
  timeoutMilliseconds?: number;
  fetchImplementation?: FetchImplementation;
  stateDirectory?: string;
  now?: Date;
}

export interface ConnectionReceipt {
  connected: true;
  mode: "mock" | "local-api";
  networkAccessed: boolean;
  snapshotUploadEnabled: boolean;
  endpointOrigin: string | null;
  grantExpiresAt: string | null;
}

interface ConnectionRequest {
  protocolVersion: typeof CONNECT_PROTOCOL_VERSION;
  uploadSessionId: string;
  deviceCode: string;
  client: {
    command: "buildstory";
    version: typeof SCANNER_VERSION;
  };
  capabilities: {
    projectSnapshotSchemaVersions: [typeof PROJECT_SNAPSHOT_SCHEMA_VERSION];
    snapshotUpload: false;
  };
}

interface ParsedLocalEndpoint {
  mode: "local-api";
  baseUrl: URL;
  connectUrl: URL;
  origin: string;
}

interface ParsedMockEndpoint {
  mode: "mock";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validateCredential(label: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new ScannerError(
      "CONNECT_ARGUMENT_INVALID",
      `${label} has an invalid format. Copy the value exactly from the dashboard and do not include angle brackets.`,
      2,
    );
  }
}

export function parseConnectEndpoint(
  rawValue: string | undefined,
  allowHost?: string,
): ParsedMockEndpoint | ParsedLocalEndpoint {
  const value = rawValue?.trim();
  if (!value) {
    throw new ScannerError(
      "CONNECT_ENDPOINT_REQUIRED",
      "Pass the running local web app URL with --api-base-url, for example http://127.0.0.1:3000/.",
      2,
    );
  }
  if (value === MOCK_API_BASE_URL || value === `${MOCK_API_BASE_URL}/`) return { mode: "mock" };

  const baseUrl = normalizeApiBase(value);
  if (!baseUrl) {
    throw new ScannerError(
      "CONNECT_ENDPOINT_NOT_LOCAL",
      "Only mock://local, a loopback HTTP(S) API base URL, or an explicit HTTPS host paired with --allow-host is allowed; URL credentials, query strings, and fragments are refused.",
      2,
    );
  }
  if (!isLoopbackHostname(baseUrl.hostname)) {
    const trimmedAllowHost = allowHost?.trim().toLocaleLowerCase("en-US");
    if (!trimmedAllowHost) {
      throw new ScannerError(
        "CONNECT_ALLOW_HOST_REQUIRED",
        "A non-loopback --api-base-url requires --allow-host matching its exact hostname. This is a deliberate second confirmation - it is not inferred from --api-base-url.",
        2,
      );
    }
    if (trimmedAllowHost !== baseUrl.hostname.toLocaleLowerCase("en-US")) {
      throw new ScannerError(
        "CONNECT_ALLOW_HOST_MISMATCH",
        "--allow-host does not match the --api-base-url hostname. Nothing was sent.",
        2,
      );
    }
  }
  return {
    mode: "local-api",
    baseUrl,
    connectUrl: new URL(CONNECT_PATH, baseUrl),
    origin: baseUrl.origin,
  };
}

function validateConnectionResponse(
  value: unknown,
  uploadSessionId: string,
  endpoint: ParsedLocalEndpoint,
  now: Date,
): StoredUploadGrant {
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "status", "uploadSessionId", "connectionId", "uploadGrant"])
    || value.protocolVersion !== CONNECT_PROTOCOL_VERSION
    || value.status !== "connected"
    || value.uploadSessionId !== uploadSessionId
    || typeof value.connectionId !== "string"
    || value.connectionId.length < 1
    || value.connectionId.length > 200
    || !isRecord(value.uploadGrant)) {
    throw new ScannerError(
      "CONNECT_RESPONSE_INVALID",
      "The local API response did not match connection protocol 1.0. Verify that the local web app and CLI versions are compatible.",
    );
  }

  const grant = value.uploadGrant;
  const expiresAt = typeof grant.expiresAt === "string" ? new Date(grant.expiresAt) : new Date(Number.NaN);
  const endpointUrl = typeof grant.snapshotEndpoint === "string"
    ? resolveTrustedApiUrl(grant.snapshotEndpoint, endpoint.baseUrl)
    : null;
  if (!hasExactKeys(grant, ["bearerToken", "snapshotEndpoint", "expiresAt", "schemaVersion", "maxBytes"])
    || typeof grant.bearerToken !== "string"
    || grant.bearerToken.length < 16
    || grant.bearerToken.length > 4096
    || /[\s\u0000-\u001f\u007f]/u.test(grant.bearerToken)
    || !endpointUrl
    || endpointUrl.origin !== endpoint.baseUrl.origin
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() > now.getTime() + MAX_GRANT_LIFETIME_MILLISECONDS
    || grant.schemaVersion !== PROJECT_SNAPSHOT_SCHEMA_VERSION
    || !Number.isSafeInteger(grant.maxBytes)
    || (grant.maxBytes as number) < 1
    || (grant.maxBytes as number) > MAX_SNAPSHOT_UPLOAD_BYTES) {
    throw new ScannerError(
      "CONNECT_GRANT_INVALID",
      "The local API returned an invalid upload grant. It must be one-use, short-lived, schema-compatible, byte-bounded, and same-origin as the connected API base.",
    );
  }

  return {
    stateVersion: 1,
    phase: "ready",
    bearerToken: grant.bearerToken,
    snapshotEndpoint: endpointUrl.href,
    expiresAt: expiresAt.toISOString(),
    schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
    maxBytes: grant.maxBytes as number,
  };
}

function timeoutError(timeoutMilliseconds: number): ScannerError {
  return new ScannerError(
    "CONNECT_TIMEOUT",
    `The API did not respond within ${timeoutMilliseconds} milliseconds. Verify --api-base-url and that the service is reachable.`,
  );
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
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
      throw new ScannerError("CONNECT_RESPONSE_TOO_LARGE", "The local API response exceeded the 64 KiB safety limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function connectBuildStory(options: ConnectOptions): Promise<ConnectionReceipt> {
  validateCredential("The upload session ID", options.uploadSessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
  validateCredential("The device code", options.deviceCode, /^[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/);
  const endpoint = parseConnectEndpoint(options.apiBaseUrl, options.allowHost);
  if (endpoint.mode === "mock") {
    return {
      connected: true,
      mode: "mock",
      networkAccessed: false,
      snapshotUploadEnabled: false,
      endpointOrigin: null,
      grantExpiresAt: null,
    };
  }

  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 60_000) {
    throw new ScannerError("CONNECT_TIMEOUT_INVALID", "The connection timeout must be between 100 and 60000 milliseconds.", 2);
  }

  const request: ConnectionRequest = {
    protocolVersion: CONNECT_PROTOCOL_VERSION,
    uploadSessionId: options.uploadSessionId,
    deviceCode: options.deviceCode,
    client: { command: "buildstory", version: SCANNER_VERSION },
    capabilities: {
      projectSnapshotSchemaVersions: [PROJECT_SNAPSHOT_SCHEMA_VERSION],
      snapshotUpload: false,
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  let storedGrant: StoredUploadGrant;
  try {
    let response: Response;
    try {
      response = await (options.fetchImplementation ?? globalThis.fetch)(endpoint.connectUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-buildstory-client-version": SCANNER_VERSION,
        },
        body: JSON.stringify(request),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw timeoutError(timeoutMilliseconds);
      throw new ScannerError(
        "CONNECT_UNAVAILABLE",
        "The configured local API is unavailable. Start the local web app and verify --api-base-url and its port.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ScannerError(
        "CONNECT_REJECTED",
        `The local API rejected the connection request (HTTP ${response.status}). Copy a fresh upload session ID and device code from the dashboard.`,
      );
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new ScannerError("CONNECT_RESPONSE_TOO_LARGE", "The local API response exceeded the 64 KiB safety limit.");
    }

    let responseText: string;
    try {
      responseText = await readBoundedResponse(response);
    } catch (error) {
      if (error instanceof ScannerError) throw error;
      if (controller.signal.aborted) throw timeoutError(timeoutMilliseconds);
      throw new ScannerError("CONNECT_RESPONSE_INVALID", "The local API response could not be read.");
    }

    let responsePayload: unknown;
    try {
      responsePayload = JSON.parse(responseText);
    } catch {
      throw new ScannerError("CONNECT_RESPONSE_INVALID", "The local API returned invalid JSON.");
    }
    storedGrant = validateConnectionResponse(responsePayload, options.uploadSessionId, endpoint, options.now ?? new Date());
  } finally {
    clearTimeout(timeout);
  }

  await storeUploadGrant(storedGrant, options.stateDirectory);
  return {
    connected: true,
    mode: "local-api",
    networkAccessed: true,
    snapshotUploadEnabled: true,
    endpointOrigin: endpoint.origin,
    grantExpiresAt: storedGrant.expiresAt,
  };
}
