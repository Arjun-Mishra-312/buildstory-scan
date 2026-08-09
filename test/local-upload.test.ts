import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { connectBuildStory } from "../src/connect.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "../src/contract.js";
import { ScannerError } from "../src/errors.js";
import { readLocalDashboardStatus, uploadProjectSnapshot } from "../src/local-upload.js";
import { buildProjectSnapshot } from "../src/scanner.js";
import { createLocalFixture } from "./helpers.js";

test("upload errors never surface an untrusted server response body", async () => {
  const fixture = await createLocalFixture();
  const stateDirectory = path.join(fixture.root, "content-free-upload-error-state");
  const serverSecret = "server-secret-that-must-never-reach-terminal";
  try {
    await connectBuildStory({
      uploadSessionId: "session-error-001",
      deviceCode: "DEVICE-CODE-ERROR-001",
      apiBaseUrl: "http://127.0.0.1:8787/",
      stateDirectory,
      fetchImplementation: async () => new Response(JSON.stringify({
        protocolVersion: "1.0",
        status: "connected",
        uploadSessionId: "session-error-001",
        connectionId: "connection-error-001",
        uploadGrant: {
          bearerToken: "fixture-error-one-use-bearer-token-001",
          snapshotEndpoint: "/api/v1/cli/snapshots/error-001",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
          maxBytes: 1024 * 1024,
        },
        narrative: { mode: "off", model: null },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });
    await assert.rejects(
      uploadProjectSnapshot(snapshot, {
        stateDirectory,
        fetchImplementation: async () => new Response(JSON.stringify({ error: { message: serverSecret, details: [serverSecret] } }), { status: 500 }),
      }),
      (error: unknown) => error instanceof ScannerError
        && error.code === "UPLOAD_REJECTED"
        && !error.message.includes(serverSecret)
        && error.message.includes("manual retry"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a pinned HTTPS remote host completes connect, upload, and status without any loopback endpoint", async () => {
  const fixture = await createLocalFixture();
  const stateDirectory = path.join(fixture.root, "remote-e2e-state");
  const bearerToken = "fixture-remote-one-use-bearer-token-001";
  let uploadAuthorization = "";
  let statusRequests = 0;

  try {
    await connectBuildStory({
      uploadSessionId: "session-remote-001",
      deviceCode: "DEVICE-CODE-REMOTE-001",
      apiBaseUrl: "https://api.example.invalid/",
      allowHost: "api.example.invalid",
      stateDirectory,
      fetchImplementation: async () => new Response(JSON.stringify({
        protocolVersion: "1.0",
        status: "connected",
        uploadSessionId: "session-remote-001",
        connectionId: "remote-connection-001",
        uploadGrant: {
          bearerToken,
          snapshotEndpoint: "https://api.example.invalid/api/v1/cli/snapshots/remote-001",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
          maxBytes: 1024 * 1024,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });

    const receipt = await uploadProjectSnapshot(snapshot, {
      stateDirectory,
      fetchImplementation: async (input, init) => {
        assert.equal(String(input), "https://api.example.invalid/api/v1/cli/snapshots/remote-001");
        uploadAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        const body = JSON.parse(String(init?.body)) as { scanId: string };
        return new Response(JSON.stringify({
          protocolVersion: "1.0",
          status: "accepted",
          receipt: {
            receiptId: "receipt-remote-001",
            scanId: body.scanId,
            snapshotDigest: new Headers(init?.headers).get("x-buildstory-snapshot-digest"),
            acceptedAt: new Date().toISOString(),
          },
          statusUrl: "https://api.example.invalid/api/v1/cli/status/remote-001",
          reportUrl: null,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(receipt.accepted, true);
    assert.equal(uploadAuthorization, `Bearer ${bearerToken}`);

    const status = await readLocalDashboardStatus({
      stateDirectory,
      fetchImplementation: async (input) => {
        statusRequests += 1;
        assert.equal(String(input), "https://api.example.invalid/api/v1/cli/status/remote-001");
        return new Response(JSON.stringify({
          protocolVersion: "1.0",
          status: "ready",
          reportReady: false,
          narrativeStatus: "generating",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(statusRequests, 1);
    assert.equal(status.source, "dashboard");
    if (status.source === "dashboard") {
      assert.equal(status.lifecycle, "ready");
      assert.equal(status.reportReady, false);
      assert.equal(status.narrativeStatus, "generating");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a remote grant that tries to redirect status reads off the pinned origin is refused", async () => {
  const fixture = await createLocalFixture();
  const stateDirectory = path.join(fixture.root, "remote-hijack-state");
  const bearerToken = "fixture-remote-one-use-bearer-token-002";

  try {
    await connectBuildStory({
      uploadSessionId: "session-remote-002",
      deviceCode: "DEVICE-CODE-REMOTE-002",
      apiBaseUrl: "https://api.example.invalid/",
      allowHost: "api.example.invalid",
      stateDirectory,
      fetchImplementation: async () => new Response(JSON.stringify({
        protocolVersion: "1.0",
        status: "connected",
        uploadSessionId: "session-remote-002",
        connectionId: "remote-connection-002",
        uploadGrant: {
          bearerToken,
          snapshotEndpoint: "https://api.example.invalid/api/v1/cli/snapshots/remote-002",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
          maxBytes: 1024 * 1024,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const snapshot = await buildProjectSnapshot({
      repositoryPath: fixture.repository,
      consent: "local-scan",
      providers: ["codex"],
      codexHome: fixture.codexHome,
      since: "2026-08-03T00:00:00Z",
      until: "2026-08-04T00:00:00Z",
    });

    await assert.rejects(
      uploadProjectSnapshot(snapshot, {
        stateDirectory,
        fetchImplementation: async () => new Response(JSON.stringify({
          protocolVersion: "1.0",
          status: "accepted",
          receipt: {
            receiptId: "receipt-remote-002",
            scanId: snapshot.scanId,
            snapshotDigest: "sha256:" + "0".repeat(64),
            acceptedAt: new Date().toISOString(),
          },
          statusUrl: "https://attacker.example.invalid/status",
          reportUrl: null,
        }), { status: 200, headers: { "content-type": "application/json" } }),
      }),
      (error: unknown) => error instanceof ScannerError && error.code === "UPLOAD_RESPONSE_INVALID",
    );
  } finally {
    await fixture.cleanup();
  }
});
