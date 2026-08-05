import type { ProjectSnapshot } from "./contract.js";
import {
  readLocalDashboardStatus,
  uploadProjectSnapshot,
  type LocalStatusResult,
  type LocalUploadReceipt,
  type UploadProjectSnapshotOptions,
} from "./local-upload.js";

/**
 * The only implemented snapshot transport. Its API cannot receive a repository path,
 * session adapter, transcript record, Git output, source body, diff, or diagnostic log.
 */
export interface SnapshotTransport {
  upload(snapshot: ProjectSnapshot): Promise<LocalUploadReceipt>;
  status(): Promise<LocalStatusResult>;
}

export class LoopbackSnapshotTransport implements SnapshotTransport {
  public constructor(private readonly options: UploadProjectSnapshotOptions = {}) {}

  public async upload(snapshot: ProjectSnapshot): Promise<LocalUploadReceipt> {
    return uploadProjectSnapshot(snapshot, this.options);
  }

  public async status(): Promise<LocalStatusResult> {
    return readLocalDashboardStatus(this.options);
  }
}

export type UploadLifecycleState =
  | "local-built"
  | "local-validated"
  | "explicitly-authorized"
  | "grant-claimed"
  | "transmitting"
  | "accepted"
  | "status-readable"
  | "failed";

/**
 * HTTP is implemented for loopback URLs (local development) and for a
 * single explicitly pinned HTTPS remote host per connection (--allow-host,
 * or --remote for the default hosted origin) - never an arbitrary or
 * unconfirmed remote host.
 */
export const LOOPBACK_SNAPSHOT_UPLOAD_IMPLEMENTED = true as const;
export const REMOTE_SNAPSHOT_UPLOAD_IMPLEMENTED = true as const;
export const NETWORK_UPLOAD_IMPLEMENTED = true as const;
