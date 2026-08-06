import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], environment: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function runInstalledBuildStory(binDirectory: string, args: string[]): Promise<CommandResult> {
  const environment = {
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    BUILDSTORY_STATE_DIR: path.join(binDirectory, ".buildstory-test-state"),
  };
  if (process.platform === "win32") {
    const safeArguments = args.map((value) => `'${value.replaceAll("'", "''")}'`).join(" ");
    return runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `& buildstory ${safeArguments}`],
      environment,
    );
  }
  return runCommand("buildstory", args, environment);
}

test("locally packed install exposes the advertised buildstory command", { timeout: 30_000 }, async () => {
  const npmCliPath = process.env.npm_execpath;
  assert.ok(npmCliPath, "npm_execpath is required for the package smoke test");
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "buildstory-package-smoke-"));
  const artifactDirectory = path.join(temporaryRoot, "artifact");
  const installDirectory = path.join(temporaryRoot, "install");
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
  ]);
  try {
    const packed = await runCommand(process.execPath, [
      npmCliPath,
      "pack",
      packageRoot,
      "--pack-destination", artifactDirectory,
      "--ignore-scripts",
      "--json",
    ]);
    assert.equal(packed.exitCode, 0, packed.stderr);
    const archiveName = (await readdir(artifactDirectory)).find((name) => name.endsWith(".tgz"));
    assert.ok(archiveName, "npm pack did not create a tarball");
    const installed = await runCommand(process.execPath, [
      npmCliPath,
      "install",
      "--prefix", installDirectory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      path.join(artifactDirectory, archiveName),
    ]);
    assert.equal(installed.exitCode, 0, installed.stderr);

    const binDirectory = path.join(installDirectory, "node_modules", ".bin");
    await access(path.join(binDirectory, process.platform === "win32" ? "buildstory.cmd" : "buildstory"));
    await access(path.join(binDirectory, process.platform === "win32" ? "story-scanner.cmd" : "story-scanner"));
    const version = await runInstalledBuildStory(binDirectory, ["--version"]);
    assert.equal(version.exitCode, 0, version.stderr);
    assert.equal(version.stdout.trim(), "0.6.0");

    const mockConnect = await runInstalledBuildStory(binDirectory, [
      "connect", "session-smoke-001", "--code", "DEVICE-CODE-001", "--api-base-url", "mock://local",
    ]);
    assert.equal(mockConnect.exitCode, 0, mockConnect.stderr);
    assert.match(mockConnect.stdout, /mock connection accepted locally/);
    assert.match(mockConnect.stdout, /No network request was made/);
    assert.match(mockConnect.stdout, /no snapshot was uploaded/i);

    const status = await runInstalledBuildStory(binDirectory, ["status"]);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.match(status.stdout, /No local dashboard connection is stored/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
