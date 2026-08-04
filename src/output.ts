import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { ProjectSnapshot } from "./contract.js";
import { ScannerError } from "./errors.js";
import { isPathWithin } from "./repository.js";

export interface WriteSnapshotOptions {
  outputPath: string;
  repositoryRoot: string;
  overwrite?: boolean;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch {
    return false;
  }
}

export async function writeSnapshotFile(
  snapshot: ProjectSnapshot,
  options: WriteSnapshotOptions,
): Promise<string> {
  const parent = path.dirname(path.resolve(options.outputPath));
  let parentRealPath: string;
  try {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new ScannerError("OUTPUT_PARENT_UNSAFE", "The output parent must be an existing, non-symlink directory.");
    }
    parentRealPath = await realpath(parent);
  } catch (error) {
    if (error instanceof ScannerError) throw error;
    throw new ScannerError("OUTPUT_PARENT_UNREADABLE", "The output parent directory does not exist or cannot be read.");
  }

  const repositoryRealPath = await realpath(options.repositoryRoot);
  if (isPathWithin(repositoryRealPath, parentRealPath)) {
    throw new ScannerError(
      "OUTPUT_INSIDE_REPOSITORY",
      "The output file must be outside the selected repository to preserve read-only repository access.",
    );
  }

  const target = path.join(parentRealPath, path.basename(options.outputPath));
  const exists = await pathExists(target);
  if (exists) {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new ScannerError("OUTPUT_TARGET_UNSAFE", "The output target must be a regular file or a new path.");
    }
    if (!options.overwrite) {
      throw new ScannerError("OUTPUT_EXISTS", "The output file already exists; pass --overwrite to replace it.");
    }
  }

  const temporaryPath = path.join(parentRealPath, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(canonicalJson(snapshot), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, target);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ScannerError("OUTPUT_WRITE_FAILED", "The validated snapshot could not be moved into the output path.");
  }
  return target;
}
