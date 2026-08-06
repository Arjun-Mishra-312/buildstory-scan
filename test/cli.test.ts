import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "../src/contract.js";
import { validateProjectSnapshot } from "../src/validation.js";
import { createLocalFixture } from "./helpers.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runProcess(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<ProcessResult> {
  const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
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

test("CLI connect without endpoint gives an actionable setup error", async () => {
  const result = await runProcess(
    ["connect", "session-demo-001", "--code", "DEVICE-CODE-001"],
    { BUILDSTORY_API_BASE_URL: "" },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /CONNECT_ENDPOINT_REQUIRED/);
  assert.match(result.stderr, /--api-base-url/);
  assert.match(result.stderr, /127\.0\.0\.1/);
  assert.equal(result.stderr.includes("DEVICE-CODE-001"), false);
  assert.equal(result.stderr.includes("session-demo-001"), false);
});

test("CLI --remote conflicts with an explicit --api-base-url or --allow-host", async () => {
  const withApiBaseUrl = await runProcess([
    "connect", "session-demo-remote",
    "--code", "DEVICE-CODE-REMOTE",
    "--remote",
    "--api-base-url", "https://staging.example.invalid/",
  ]);
  assert.equal(withApiBaseUrl.exitCode, 2);
  assert.match(withApiBaseUrl.stderr, /CONNECT_REMOTE_CONFLICT/);

  const withAllowHost = await runProcess([
    "connect", "session-demo-remote",
    "--code", "DEVICE-CODE-REMOTE",
    "--remote",
    "--allow-host", "staging.example.invalid",
  ]);
  assert.equal(withAllowHost.exitCode, 2);
  assert.match(withAllowHost.stderr, /CONNECT_REMOTE_CONFLICT/);
});

test("CLI connect requires --allow-host for a non-loopback --api-base-url", async () => {
  const result = await runProcess([
    "connect", "session-demo-remote",
    "--code", "DEVICE-CODE-REMOTE",
    "--api-base-url", "https://api.example.invalid/",
  ]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /CONNECT_ALLOW_HOST_REQUIRED/);
  assert.match(result.stderr, /--allow-host/);
});

test("CLI connect performs only the documented handshake and stores a bounded grant", async () => {
  const fixture = await createLocalFixture();
  let capturedRequest: Record<string, unknown> | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      capturedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "1.0",
        status: "connected",
        uploadSessionId: capturedRequest.uploadSessionId,
        connectionId: "local-connection-001",
        uploadGrant: {
          bearerToken: "fixture-one-use-bearer-token-001",
          snapshotEndpoint: "/api/v1/cli/snapshots/fixture-001",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
          maxBytes: 1024 * 1024,
        },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address() as AddressInfo;
    const result = await runProcess([
      "connect", "session-demo-001",
      "--code", "DEVICE-CODE-001",
      "--api-base-url", `http://127.0.0.1:${address.port}`,
    ], { BUILDSTORY_STATE_DIR: path.join(fixture.root, "connection-state") });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /connection accepted/);
    assert.match(result.stdout, /one-PUT grant/);
    assert.match(result.stdout, /no snapshot was uploaded/i);
    assert.equal(result.stdout.includes("DEVICE-CODE-001"), false);
    assert.equal(result.stdout.includes("session-demo-001"), false);
    const confirmedRequest = capturedRequest as Record<string, unknown> | null;
    assert.ok(confirmedRequest);
    assert.deepEqual(Object.keys(confirmedRequest).sort(), ["capabilities", "client", "deviceCode", "protocolVersion", "uploadSessionId"]);
    const capabilities = confirmedRequest.capabilities as Record<string, unknown>;
    assert.equal(capabilities.snapshotUpload, false);
    assert.equal("snapshot" in confirmedRequest, false);
    assert.equal("repository" in confirmedRequest, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fixture.cleanup();
  }
});

test("CLI completes connect, validated one-PUT upload, and authenticated status locally", async () => {
  const fixture = await createLocalFixture();
  const stateDirectory = path.join(fixture.root, "e2e-state");
  const bearerToken = "fixture-private-one-use-bearer-token-002";
  let baseUrl = "";
  let uploadCount = 0;
  let uploadedBody = "";
  let uploadAuthorization = "";
  let statusAuthorization = "";
  let reportAuthorization = "";

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/cli/status/fixture-002") {
      statusAuthorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocolVersion: "1.0", status: "ready", reportReady: true }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/cli/reports/fixture-002") {
      reportAuthorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "1.0",
        status: "ready",
        report: {
          summary: "A local redacted build report is ready.",
          sessionCount: 1,
          commitCount: 1,
          milestoneCount: 2,
          warningCount: 0,
        },
      }));
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "POST" && request.url === "/api/v1/cli/connect") {
        const connectionRequest = JSON.parse(body) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: "1.0",
          status: "connected",
          uploadSessionId: connectionRequest.uploadSessionId,
          connectionId: "local-connection-002",
          uploadGrant: {
            bearerToken,
            snapshotEndpoint: "/api/v1/cli/snapshots/fixture-002",
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
            maxBytes: 1024 * 1024,
          },
        }));
        return;
      }
      if (request.method === "PUT" && request.url === "/api/v1/cli/snapshots/fixture-002") {
        uploadCount += 1;
        uploadedBody = body;
        uploadAuthorization = request.headers.authorization ?? "";
        const snapshot = JSON.parse(body) as { scanId: string };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocolVersion: "1.0",
          status: "accepted",
          receipt: {
            receiptId: "receipt-fixture-002",
            scanId: snapshot.scanId,
            snapshotDigest: request.headers["x-buildstory-snapshot-digest"],
            acceptedAt: new Date().toISOString(),
          },
          statusUrl: `${baseUrl}api/v1/cli/status/fixture-002`,
          reportUrl: "/api/v1/cli/reports/fixture-002",
        }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/`;
    const environment = { BUILDSTORY_STATE_DIR: stateDirectory };
    const connect = await runProcess([
      "connect", "session-demo-002",
      "--code", "DEVICE-CODE-002",
      "--api-base-url", baseUrl,
    ], environment);
    assert.equal(connect.exitCode, 0, connect.stderr);
    assert.equal(connect.stdout.includes(bearerToken), false);

    const scanUploadArguments = [
      "scan-upload",
      "--repo", fixture.repository,
      "--source", "codex",
      "--codex-home", fixture.codexHome,
      "--consent", "local-scan",
      "--upload-consent", "local-dashboard",
      "--since", "2026-08-03T00:00:00Z",
      "--until", "2026-08-04T00:00:00Z",
    ];
    const upload = await runProcess(scanUploadArguments, environment);
    assert.equal(upload.exitCode, 0, upload.stderr);
    assert.match(
      upload.stdout,
      new RegExp(`Validated and uploaded ProjectSnapshot ${PROJECT_SNAPSHOT_SCHEMA_VERSION.replaceAll(".", "\\.")}`),
    );
    assert.match(upload.stdout, /accepted the one-PUT snapshot/);
    assert.equal(upload.stdout.includes(fixture.repository), false);
    assert.equal(upload.stdout.includes(bearerToken), false);
    assert.equal(uploadCount, 1);
    assert.equal(uploadAuthorization, `Bearer ${bearerToken}`);

    const snapshot: unknown = JSON.parse(uploadedBody);
    validateProjectSnapshot(snapshot);
    assert.equal(uploadedBody, canonicalJson(snapshot));
    assert.equal(uploadedBody.includes(fixture.repository), false);
    assert.equal(uploadedBody.includes("private.example.invalid"), false);
    assert.equal(uploadedBody.includes("secret-repository"), false);
    assert.equal(uploadedBody.includes('"host"'), false);
    assert.equal(uploadedBody.includes("synthetic transcript body"), false);
    assert.equal(uploadedBody.includes("synthetic tool payload"), false);

    const repeatedUpload = await runProcess(scanUploadArguments, environment);
    assert.equal(repeatedUpload.exitCode, 2);
    assert.match(repeatedUpload.stderr, /UPLOAD_GRANT_ALREADY_USED/);
    assert.equal(uploadCount, 1);

    const status = await runProcess(["status"], environment);
    assert.equal(status.exitCode, 0, status.stderr);
    assert.match(status.stdout, /lifecycle: ready/);
    assert.match(status.stdout, /local redacted build report/);
    assert.match(status.stdout, /1 sessions, 1 commits, 2 milestones, 0 warnings/);
    assert.equal(status.stdout.includes(bearerToken), false);
    assert.equal(statusAuthorization, `Bearer ${bearerToken}`);
    assert.equal(reportAuthorization, `Bearer ${bearerToken}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fixture.cleanup();
  }
});

test("CLI requires local-scan consent before discovery", async () => {
  const fixture = await createLocalFixture();
  try {
    const result = await runProcess(["scan", "--repo", fixture.repository, "--source", "codex", "--dry-run"]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /CONSENT_REQUIRED/);
    assert.equal(result.stderr.includes(fixture.repository), false);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI dry-run emits a valid payload and writes no snapshot", async () => {
  const fixture = await createLocalFixture();
  try {
    const result = await runProcess([
      "scan",
      "--repo", fixture.repository,
      "--source", "codex",
      "--codex-home", fixture.codexHome,
      "--consent", "local-scan",
      "--since", "2026-08-03T00:00:00Z",
      "--until", "2026-08-04T00:00:00Z",
      "--dry-run",
      "--quiet",
    ], { BUILDSTORY_OLLAMA_TIMEOUT_MS: "1000" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, "");
    const snapshot: unknown = JSON.parse(result.stdout);
    validateProjectSnapshot(snapshot);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI output mode writes a validated snapshot outside the repository", async () => {
  const fixture = await createLocalFixture();
  try {
    const outputPath = path.join(fixture.outputDirectory, "cli-snapshot.json");
    const result = await runProcess([
      "scan",
      "--repo", fixture.repository,
      "--source", "codex",
      "--codex-home", fixture.codexHome,
      "--consent", "local-scan",
      "--since", "2026-08-03T00:00:00Z",
      "--until", "2026-08-04T00:00:00Z",
      "--output", outputPath,
    ], { BUILDSTORY_OLLAMA_TIMEOUT_MS: "1000" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Discovering providers/);
    assert.match(result.stdout, new RegExp(`Wrote ${PROJECT_SNAPSHOT_SCHEMA_VERSION.replaceAll(".", "\\.")} snapshot scan_`));
    const snapshot: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    validateProjectSnapshot(snapshot);
  } finally {
    await fixture.cleanup();
  }
});
