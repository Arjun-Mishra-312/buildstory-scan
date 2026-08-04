# Local connection protocol 1.0

`buildstory connect UPLOAD_SESSION_ID --code DEVICE_CODE --api-base-url LOOPBACK_URL` exchanges dashboard device credentials for a bounded upload grant. Connect does not scan, read a repository, or upload a snapshot.

## Endpoint rules

The API base comes from `--api-base-url`, then `BUILDSTORY_API_BASE_URL` as a compatibility fallback. The CLI accepts `mock://local` or loopback HTTP(S) only: `localhost`, `127.0.0.0/8`, and `::1`. It refuses remote hosts, URL credentials, queries, fragments, and redirects. A path prefix is supported; `api/v1/cli/connect` is appended beneath it.

`mock://local` is in-process command validation. It contacts nothing and returns no grant.

## Connect request

The existing request is unchanged. The loopback API receives one `POST` with `Content-Type: application/json`:

```json
{
  "protocolVersion": "1.0",
  "uploadSessionId": "UPLOAD_SESSION_ID",
  "deviceCode": "DEVICE_CODE",
  "client": {
    "command": "buildstory",
    "version": "0.3.0"
  },
  "capabilities": {
    "projectSnapshotSchemaVersions": ["1.0.0"],
    "snapshotUpload": false
  }
}
```

`snapshotUpload: false` means the connect request itself contains no snapshot. No other fields are sent: no repository identity, path, source/transcript data, Git data, environment inventory, or diagnostic body.

## Connect response and grant

Success is HTTP 2xx and this strict JSON object, no larger than 64 KiB:

```json
{
  "protocolVersion": "1.0",
  "status": "connected",
  "uploadSessionId": "UPLOAD_SESSION_ID",
  "connectionId": "LOCAL_API_GENERATED_ID",
  "uploadGrant": {
    "bearerToken": "SHORT_LIVED_ONE_USE_VALUE",
    "snapshotEndpoint": "/api/v1/cli/snapshots/OPAQUE_ID",
    "expiresAt": "2026-08-04T12:05:00.000Z",
    "schemaVersion": "1.0.0",
    "maxBytes": 1048576
  }
}
```

The upload-session ID and protocol must match the request. `connectionId` is validated but never printed or persisted. The grant must:

- expire in the future and no more than one hour after acceptance;
- bind to `ProjectSnapshot 1.0.0`;
- cap the body between 1 byte and the CLI's 8 MiB hard maximum;
- provide a relative or absolute snapshot endpoint that resolves to the same loopback origin as the explicit API base;
- carry a non-empty bearer with no whitespace or control characters.

The CLI persists only the grant. It never persists the device code, upload-session ID, connection ID, request body, repository data, or snapshot. State is placed in the platform-local application state directory, with directory/file modes 0700/0600 where supported. `BUILDSTORY_STATE_DIR` exists for isolated testing.

## Failure behavior

- Missing configuration fails before network access with `CONNECT_ENDPOINT_REQUIRED`.
- Unreachable or timed-out APIs fail with `CONNECT_UNAVAILABLE` or `CONNECT_TIMEOUT`.
- Non-2xx responses fail with `CONNECT_REJECTED`; bodies are not printed.
- Missing, mismatched, expired, oversized, remote, cross-origin, or malformed grants fail closed.
- Errors never include the session ID, device code, bearer, response body, or stack trace.

The default timeout is five seconds; `--timeout-ms` accepts 100 through 60000 milliseconds. A successful connect authorizes no repository read and performs no upload. `scan-upload` still requires both explicit consent flags.
