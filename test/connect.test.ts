import assert from "node:assert/strict";
import test from "node:test";
import { connectBuildStory } from "../src/connect.js";
import { PROJECT_SNAPSHOT_SCHEMA_VERSION } from "../src/contract.js";
import { ScannerError } from "../src/errors.js";

test("mock connection is explicit and performs no network request", async () => {
  let fetchCalled = false;
  const receipt = await connectBuildStory({
    uploadSessionId: "session-demo-001",
    deviceCode: "DEVICE-CODE-001",
    apiBaseUrl: "mock://local",
    fetchImplementation: async () => {
      fetchCalled = true;
      throw new Error("must not run");
    },
  });
  assert.equal(fetchCalled, false);
  assert.deepEqual(receipt, {
    connected: true,
    mode: "mock",
    networkAccessed: false,
    snapshotUploadEnabled: false,
    endpointOrigin: null,
    grantExpiresAt: null,
  });
});

test("connect refuses remote and credential-bearing endpoints", async () => {
  for (const apiBaseUrl of ["https://api.example.invalid", "http://user:secret@127.0.0.1:8787"]) {
    await assert.rejects(
      connectBuildStory({
        uploadSessionId: "session-demo-001",
        deviceCode: "DEVICE-CODE-001",
        apiBaseUrl,
      }),
      (error: unknown) => error instanceof ScannerError && error.code === "CONNECT_ENDPOINT_NOT_LOCAL",
    );
  }
});

test("unavailable local API returns an actionable content-free error", async () => {
  await assert.rejects(
    connectBuildStory({
      uploadSessionId: "session-demo-001",
      deviceCode: "DEVICE-CODE-001",
      apiBaseUrl: "http://127.0.0.1:8787",
      fetchImplementation: async () => {
        throw new Error("synthetic device code must not appear in output");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScannerError);
      assert.equal(error.code, "CONNECT_UNAVAILABLE");
      assert.match(error.message, /Start the local web app/);
      assert.equal(error.message.includes("DEVICE-CODE-001"), false);
      assert.equal(error.message.includes("session-demo-001"), false);
      return true;
    },
  );
});

test("connect rejects a grant that would send the bearer to a remote endpoint", async () => {
  await assert.rejects(
    connectBuildStory({
      uploadSessionId: "session-demo-001",
      deviceCode: "DEVICE-CODE-001",
      apiBaseUrl: "http://127.0.0.1:8787/",
      fetchImplementation: async () => new Response(JSON.stringify({
        protocolVersion: "1.0",
        status: "connected",
        uploadSessionId: "session-demo-001",
        connectionId: "local-connection-001",
        uploadGrant: {
          bearerToken: "fixture-one-use-bearer-token-001",
          snapshotEndpoint: "https://remote.example.invalid/upload",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          schemaVersion: PROJECT_SNAPSHOT_SCHEMA_VERSION,
          maxBytes: 1024,
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    }),
    (error: unknown) => error instanceof ScannerError && error.code === "CONNECT_GRANT_INVALID",
  );
});
