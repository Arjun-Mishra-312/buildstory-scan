# Snapshot-upload lifecycle

`LOOPBACK_SNAPSHOT_UPLOAD_IMPLEMENTED`, `REMOTE_SNAPSHOT_UPLOAD_IMPLEMENTED`, and `NETWORK_UPLOAD_IMPLEMENTED` are all `true`. Two transports exist: a local web app on loopback (the default, `--api-base-url <loopback-url>`), and a single explicitly pinned HTTPS remote host per connection (`--remote` for the hosted origin, or `--api-base-url <https-url> --allow-host <hostname>` for anything else, e.g. staging). There is no unpinned or discovered remote destination, fallback host, background retry, telemetry channel, or pending snapshot queue - each `connect` pins exactly one origin, and every later read or write in that connection is verified same-origin against it.

## State transitions

1. **Local built** — `scan-upload` reads the selected Git/Codex metadata under `--consent local-scan`; content-bearing fields never enter the normalized model.
2. **Local validated** — the object passes Draft 2020-12 validation, forbidden-field traversal, canonical serialization, and final secret plus URL/host/path scans. Its exact byte count and SHA-256 digest are fixed.
3. **Explicitly authorized** — `--upload-consent local-dashboard` separately authorizes only this command's validated snapshot. Local-scan consent or connect alone is insufficient.
4. **Grant claimed** — the short-lived connection state is atomically removed before network transmission. Concurrent/repeated PUT attempts cannot reuse it.
5. **Transmitting** — the CLI checks the body against both the server grant and the 8 MiB hard limit, then sends exactly the canonical snapshot JSON with no envelope.
6. **Accepted** — a strict receipt must match the scan ID and local digest. Only a verified HTTP 2xx receipt counts as success.
7. **Status-readable** — after acceptance, local state contains only the same bearer, expiry, schema, and same-origin status/report URLs. The bearer can no longer authorize PUT, but the web app may accept it for read-only GET until expiry.
8. **Failed** — a content-free error is printed and no automatic retry occurs. Network failures and designated retryable HTTP statuses restore the local grant for a manual retry. Server-side grants remain one-use, so an ambiguously accepted first request is refused if replayed.

The `SnapshotTransport` interface accepts only a `ProjectSnapshot`. It cannot receive a repository path, session adapter, raw record, transcript, Git child-process output, source/diff body, device code, or diagnostic callback.

`ProjectSnapshot 1.7.0`'s `sourceSelection.consent` records collection consent: local-scan itself still denies network upload. Transport consent is deliberately separate and is evidenced by the command-scoped `--upload-consent`, one-use grant, digest-bound request, and accepted receipt; it is not silently inferred from the source-selection statement.

## Snapshot PUT

The CLI sends:

```http
PUT /granted/snapshot/path HTTP/1.1
Authorization: Bearer <one-use-grant>
Content-Type: application/json
Accept: application/json
X-BuildStory-Schema-Version: 1.7.0
X-BuildStory-Snapshot-Digest: sha256:<64 lowercase hex characters>

<the canonical ProjectSnapshot JSON object itself>
```

No cookie jar is used (`credentials: omit`), redirects are refused, and the body is not wrapped or enriched. The accepted response is strict and capped at 64 KiB:

```json
{
  "protocolVersion": "1.0",
  "status": "accepted",
  "receipt": {
    "receiptId": "OPAQUE_RECEIPT_ID",
    "scanId": "scan_0123456789abcdef01234567",
    "snapshotDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "acceptedAt": "2026-08-04T12:00:00.000Z"
  },
  "statusUrl": "/api/v1/cli/status/OPAQUE_ID",
  "reportUrl": "/api/v1/cli/reports/OPAQUE_ID"
}
```

`statusUrl` is required. `reportUrl` may be `null`. Both must resolve to same-origin URLs (loopback, or the one pinned remote host for this connection) without credentials, queries, or fragments.

## Authenticated status/report GETs

`buildstory status` sends the retained bearer—not cookies—to the stored status URL:

```json
{
  "protocolVersion": "1.0",
  "status": "accepted",
  "reportReady": false
}
```

`status` may be `accepted`, `processing`, `ready`, or `failed`. When `reportReady` is true and a report URL exists, the CLI requests it with the same bearer and accepts only:

```json
{
  "protocolVersion": "1.0",
  "status": "ready",
  "report": {
    "summary": "A bounded local report summary.",
    "sessionCount": 1,
    "commitCount": 2,
    "milestoneCount": 3,
    "warningCount": 0
  }
}
```

The CLI bounds and locally redacts the summary before displaying it. It prints lifecycle and numeric aggregates, never endpoints, bearer values, response bodies on failure, or the uploaded snapshot. Read-only access naturally ends at grant expiry.
