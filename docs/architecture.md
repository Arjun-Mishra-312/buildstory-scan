# Architecture

## Boundary-first flow

```text
selected Git worktree --read-only metadata--> repository inspector --aggregates--+
                                                                              |
selected Codex roots ----bounded JSONL------> Codex adapter ------structure---+--> redactor
                                                                                      |
                                                                                  strict schema
                                                                                      |
                                                                           canonical ProjectSnapshot
                                                                                      |
dashboard code --> loopback connect --> short-lived grant --> explicit upload consent |
                                                                                      v
                                                                      one PUT to loopback API
                                                                                      |
                                                                authenticated status/report GETs
```

There is no repository/snapshot arrow into connect and no raw-input arrow into transport. `ProjectSnapshot` is an allowlist assembled from normalized aggregates, not a redacted clone of Git or session input.

## Components

`repository.ts` resolves the selected Git top-level directory and runs Git with optional locks disabled. It derives a stable fingerprint, sanitized display name/branch, HEAD, an opaque repository-path hash, working-tree counts, and time-windowed history aggregates. A remote host is used transiently only as fingerprint input and is never returned. Source files are never opened. `git status` materializes names locally, but only counts survive; `git log --shortstat` avoids diff/path output.

`sources/codex.ts` is the first provider adapter. Discovery is deterministic and bounded by sorted traversal, depth/file limits, a 128 MiB file cap, a 4 MiB line cap, and no symlink following. An unrelated file closes when its metadata working directory proves it is out of scope. Matched message/reasoning bodies and tool arguments/results are counted by structural kind and discarded; they cannot enter the normalized provider result.

`scanner.ts` derives a stable UTC window, filters sessions, aggregates model/tool/token use, builds structural milestones and opaque evidence, and produces the scan ID from canonical payload content. `redaction.ts` sanitizes retained strings. `validation.ts` uses the portable Draft 2020-12 schema. Identical inputs/options produce identical bytes.

`connect.ts` preserves protocol 1.0's bounded POST request and validates its new nested upload grant. It accepts mock mode or explicit loopback HTTP(S) only, rejects redirects/cookies/remote URLs, caps responses, and never persists the dashboard session ID, device code, or connection ID.

`connection-state.ts` is the only credential store. It uses platform-local state, refuses a symlink as its final directory/file, performs exclusive temporary writes and replacement, and requests 0700/0600 modes. State has two discriminated forms:

- `ready`: one-PUT bearer, same-origin snapshot endpoint, expiry, schema, and byte cap;
- `uploaded`: the same bearer plus same-origin status/report URLs, with PUT unavailable.

The ready file is atomically claimed and removed before PUT, preventing concurrent CLI reuse. After a verified receipt, only read-access state is written back until expiry.

`local-upload.ts` is the data-plane implementation. It accepts a `ProjectSnapshot`, revalidates and canonicalizes it, enforces forbidden keys and secret scanning, compares byte limits, and performs one `PUT` with the canonical JSON itself. It validates a digest-bound receipt before recording read-only access. Status/report reads use strict bounded response shapes and redact the only free-form report string before output.

`transport.ts` exposes `SnapshotTransport` and `LoopbackSnapshotTransport`. The method signature can receive a `ProjectSnapshot` only—not a repository path, provider adapter, raw record, Git output, source/diff content, device credentials, or logging callback. Remote transport is explicitly false.

`output.ts` remains the local file boundary. It writes atomically outside the chosen worktree and never participates in upload.

## Package and commands

The private npm package declares:

- `buildstory`, the advertised CLI;
- `story-scanner`, a backward-compatible alias.

Commands are deliberately separated:

- `connect`: credentials in, local grant out; no scan/upload;
- `inspect`: repository identity only; no session read/network;
- `scan`: local scan plus stdout/file output; no network;
- `scan-upload`: local scan, validation, explicit consent, one loopback PUT;
- `status`: local grant state or authenticated read-only dashboard GETs.

## Determinism and schema sharing

Files, sessions, warnings, tools, models, milestones, evidence, object keys, and Git provenance labels are sorted. Default time bounds derive from repository/session state, not wall clock. JSON keys use locale-independent lexicographic ordering. The schema remains `ProjectSnapshot 1.0.0` for the coordinated local web API; scanner package version `0.3.0` identifies the new transport implementation.

The web app can import TypeScript exports from `@buildstory/scanner` and the portable schema from `@buildstory/scanner/schema`. The schema has no remote-host field and uses `additionalProperties: false` recursively.

## Adapter evolution

Providers implement `SessionProviderAdapter` and return the normalized, content-free session shape. v1 admits Codex only. Another provider requires explicit schema/type evolution, adapter registration, bounded fixtures, and equivalent early repository scoping and fail-closed tests.

## Reference provenance

1. Y Combinator's official [Paxel overview](https://paxel.ycombinator.com/) describes local Docker analysis and repository selection. Its [technical data-handling page](https://paxel.ycombinator.com/data-handling) describes read-only repository mounting, local handling of source/diffs, bounded/redacted derived payloads, source/transcript boundaries, and consent controls. BuildStory adopts only the boundary principles and emits a substantially narrower payload.
2. The third-party [`staru09/open-paxel`](https://github.com/staru09/open-paxel) repository is recorded only as an independent local-first implementation example. BuildStory does not reuse its code, storage model, command names, scoring pipeline, or implementation details.

The references were reviewed on 2026-08-03. They are provenance context, not normative dependencies; the schema, code, tests, and privacy docs here are normative.
