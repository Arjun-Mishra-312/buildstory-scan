import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** Must match the single `bin` key in package.json. */
const CLI_COMMAND = "buildstory-scan";

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
      ["-NoProfile", "-NonInteractive", "-Command", `& ${CLI_COMMAND} ${safeArguments}`],
      environment,
    );
  }
  return runCommand(CLI_COMMAND, args, environment);
}

// A cold Windows npm install can spend 30-90 seconds starting npm and
// extracting the packed archive. Keep this smoke test strict, but allow the
// first-run packaging path enough time to complete in CI and on new machines.
test("locally packed install exposes the advertised buildstory-scan command", { timeout: 120_000 }, async (t) => {
  // Set only when the runner is invoked through npm. `node --test dist/test/*.js`
  // straight from a shell is a legitimate way to run this suite, so skip rather
  // than fail - the packed-install path genuinely cannot be exercised without npm.
  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) return t.skip("requires npm_execpath; run via `npm test`");
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
    await access(path.join(binDirectory, process.platform === "win32" ? `${CLI_COMMAND}.cmd` : CLI_COMMAND));
    // The old "buildstory" and "story-scanner" aliases are deliberately gone:
    // both names are already published on npm by unrelated authors, so shipping
    // them would make a global install collide. Assert they stay unpublished.
    for (const retired of ["buildstory", "story-scanner"]) {
      await assert.rejects(access(path.join(binDirectory, process.platform === "win32" ? `${retired}.cmd` : retired)));
    }
    const version = await runInstalledBuildStory(binDirectory, ["--version"]);
    assert.equal(version.exitCode, 0, version.stderr);
    // Derived, not hardcoded: this is exactly the drift that matters - the
    // installed binary must report the version npm actually published.
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version: string };
    assert.equal(version.stdout.trim(), manifest.version);

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
