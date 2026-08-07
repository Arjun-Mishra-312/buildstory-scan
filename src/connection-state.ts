import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "./contract.js";
import type { NarrativeMode } from "./contract.js";
import { ScannerError } from "./errors.js";

const STATE_FILE_NAME = "active-upload-state.json";
const MAX_STATE_BYTES = 32 * 1024;

interface StateBase {
  stateVersion: 1;
  bearerToken: string;
  expiresAt: string;
  schemaVersion: typeof PROJECT_SNAPSHOT_SCHEMA_VERSION;
}

export interface StoredUploadGrant extends StateBase {
  phase: "ready";
  snapshotEndpoint: string;
  maxBytes: number;
  /** Absent only for grants written by pre-mode CLIs; those intentionally default to cloud. */
  narrative?: { mode: NarrativeMode; model: string | null };
}

export interface StoredStatusAccess extends StateBase {
  phase: "uploaded";
  statusUrl: string;
  reportUrl: string | null;
}

export type StoredConnectionState = StoredUploadGrant | StoredStatusAccess;

export type ConnectionStatus =
  | { state: "none" }
  | {
      state: "ready" | "uploaded" | "expired";
      expiresAt: string;
      schemaVersion: typeof PROJECT_SNAPSHOT_SCHEMA_VERSION;
      maxBytes?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidBearer(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 4096
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validateStoredState(value: unknown): StoredConnectionState {
  if (!isRecord(value)
    || value.stateVersion !== 1
    || !isValidBearer(value.bearerToken)
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt))
    || value.schemaVersion !== PROJECT_SNAPSHOT_SCHEMA_VERSION) {
    throw new ScannerError("CONNECTION_STATE_INVALID", "The local connection state is invalid. Run connect again.");
  }

  if (value.phase === "ready"
    && (hasExactKeys(value, ["stateVersion", "phase", "bearerToken", "snapshotEndpoint", "expiresAt", "schemaVersion", "maxBytes"]) || hasExactKeys(value, ["stateVersion", "phase", "bearerToken", "snapshotEndpoint", "expiresAt", "schemaVersion", "maxBytes", "narrative"]))
    && typeof value.snapshotEndpoint === "string"
    && value.snapshotEndpoint.length >= 1
    && value.snapshotEndpoint.length <= 2048
    && Number.isSafeInteger(value.maxBytes)
    && (value.maxBytes as number) >= 1
    && (value.narrative === undefined || (isRecord(value.narrative) && hasExactKeys(value.narrative, ["mode", "model"]) && ["local", "cloud", "off"].includes(value.narrative.mode as string) && (value.narrative.model === null || typeof value.narrative.model === "string")))) {
    return value as unknown as StoredUploadGrant;
  }

  if (value.phase === "uploaded"
    && hasExactKeys(value, ["stateVersion", "phase", "bearerToken", "statusUrl", "reportUrl", "expiresAt", "schemaVersion"])
    && typeof value.statusUrl === "string"
    && value.statusUrl.length >= 1
    && value.statusUrl.length <= 2048
    && (value.reportUrl === null || (typeof value.reportUrl === "string" && value.reportUrl.length >= 1 && value.reportUrl.length <= 2048))) {
    return value as unknown as StoredStatusAccess;
  }

  throw new ScannerError("CONNECTION_STATE_INVALID", "The local connection state is invalid. Run connect again.");
}

function stateDirectory(override?: string): string {
  if (override?.trim()) return path.resolve(override);
  const environmentOverride = process.env.BUILDSTORY_STATE_DIR?.trim();
  if (environmentOverride) return path.resolve(environmentOverride);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(localAppData || path.join(os.homedir(), "AppData", "Local"), "BuildStory", "Scanner");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BuildStory", "Scanner");
  }
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(xdgStateHome || path.join(os.homedir(), ".local", "state"), "buildstory-scanner");
}

function statePath(override?: string): string {
  return path.join(stateDirectory(override), STATE_FILE_NAME);
}

async function ensureStateDirectory(override?: string): Promise<string> {
  const directory = stateDirectory(override);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ScannerError("CONNECTION_STATE_UNSAFE", "The local state directory must be a real directory, not a link.");
    }
    await chmod(directory, 0o700).catch(() => undefined);
    return directory;
  } catch (error) {
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("CONNECTION_STATE_UNAVAILABLE", "The local connection state could not be stored securely.");
  }
}

async function readStateFile(filePath: string): Promise<StoredConnectionState | null> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ScannerError("CONNECTION_STATE_UNAVAILABLE", "The local connection state could not be read.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new ScannerError("CONNECTION_STATE_UNSAFE", "The local connection state file is unsafe. Remove it manually and run connect again.");
  }
  try {
    return validateStoredState(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("CONNECTION_STATE_INVALID", "The local connection state could not be read. Run connect again.");
  }
}

async function writeState(state: StoredConnectionState, override?: string): Promise<void> {
  validateStoredState(state);
  const directory = await ensureStateDirectory(override);
  const finalPath = statePath(override);
  const temporaryPath = path.join(directory, `.upload-state-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600).catch(() => undefined);

    try {
      const existing = await lstat(finalPath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new ScannerError("CONNECTION_STATE_UNSAFE", "The existing local connection state file is unsafe. Remove it manually before reconnecting.");
      }
      await rm(finalPath, { force: false });
    } catch (error) {
      if (error instanceof ScannerError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("CONNECTION_STATE_UNAVAILABLE", "The local connection state could not be stored securely.");
  }
}

export async function storeUploadGrant(grant: StoredUploadGrant, override?: string): Promise<void> {
  await writeState(grant, override);
}

export async function storeStatusAccess(access: StoredStatusAccess, override?: string): Promise<void> {
  await writeState(access, override);
}

export async function getConnectionStatus(override?: string, now = new Date()): Promise<ConnectionStatus> {
  const state = await readStateFile(statePath(override));
  if (state === null) return { state: "none" };
  if (Date.parse(state.expiresAt) <= now.getTime()) {
    return { state: "expired", expiresAt: state.expiresAt, schemaVersion: state.schemaVersion };
  }
  if (state.phase === "ready") {
    return { state: "ready", expiresAt: state.expiresAt, schemaVersion: state.schemaVersion, maxBytes: state.maxBytes };
  }
  return { state: "uploaded", expiresAt: state.expiresAt, schemaVersion: state.schemaVersion };
}

export async function getStoredStatusAccess(override?: string, now = new Date()): Promise<StoredStatusAccess | null> {
  const state = await readStateFile(statePath(override));
  if (state === null || state.phase !== "uploaded" || Date.parse(state.expiresAt) <= now.getTime()) return null;
  return state;
}

export async function getStoredUploadGrant(override?: string, now = new Date()): Promise<StoredUploadGrant | null> {
  const state = await readStateFile(statePath(override));
  if (state === null || state.phase !== "ready" || Date.parse(state.expiresAt) <= now.getTime()) return null;
  return state;
}

export type UploadGrantLease = {
  grant: StoredUploadGrant;
  release(outcome: "success" | "retryable" | "terminal"): Promise<void>;
};

/** Atomically claims the grant while retaining a recoverable lease until the upload outcome is known. */
export async function consumeUploadGrant(override?: string, now = new Date()): Promise<UploadGrantLease> {
  const directory = stateDirectory(override);
  const activePath = statePath(override);
  const claimedPath = path.join(directory, `.claimed-upload-grant-${randomUUID()}.json`);
  try {
    await rename(activePath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ScannerError(
        "UPLOAD_CONNECTION_REQUIRED",
        "No one-time local upload grant is available. Start the local web app and run buildstory-scan connect again.",
        2,
      );
    }
    throw new ScannerError("CONNECTION_STATE_UNAVAILABLE", "The one-time local upload grant could not be claimed safely.");
  }

  let restoreClaim = false;
  let leaseCreated = false;
  try {
    const state = await readStateFile(claimedPath);
    if (state === null) {
      throw new ScannerError("CONNECTION_STATE_INVALID", "The local upload grant disappeared. Run connect again.");
    }
    if (state.phase === "uploaded") {
      restoreClaim = true;
      throw new ScannerError(
        "UPLOAD_GRANT_ALREADY_USED",
        "The stored grant has already uploaded a snapshot. Run buildstory-scan status, or connect again for another upload.",
        2,
      );
    }
    if (Date.parse(state.expiresAt) <= now.getTime()) {
      throw new ScannerError("UPLOAD_GRANT_EXPIRED", "The one-time local upload grant expired. Run buildstory-scan connect again.", 2);
    }
    leaseCreated = true;
    let released = false;
    return {
      grant: state,
      async release(outcome) {
        if (released) return;
        released = true;
        if (outcome === "retryable") {
          await rename(claimedPath, activePath).catch(() => undefined);
        } else {
          await rm(claimedPath, { force: true }).catch(() => undefined);
        }
      },
    };
  } finally {
    if (restoreClaim) {
      await rename(claimedPath, activePath).catch(() => undefined);
    } else if (!leaseCreated) {
      await rm(claimedPath, { force: true }).catch(() => undefined);
    }
  }
}
