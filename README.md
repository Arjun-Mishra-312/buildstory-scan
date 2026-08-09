# BuildStory Scanner

BuildStory Scanner is a TypeScript/Node.js CLI for a desktop-first community of AI-assisted software builders. It inspects one user-selected Git worktree read-only, discovers repository-scoped AI coding-session data from Codex, Claude Code, Cursor, and Google Antigravity, discards content-bearing fields locally, and emits a deterministic `ProjectSnapshot 1.7.0`.

The CLI provides a real end-to-end transport to a BuildStory web app: a separately running **local** app by default, or a single explicitly pinned **HTTPS remote host** per connection (`--remote`, or `--api-base-url`/`--allow-host` for a non-default host). No unpinned or discovered remote endpoint is accepted.

The package is published as **`buildstory-scan`** and installs a single binary of the same name, so the thing you install, the thing you run, and the thing you `npx` are all one word. In the consolidated repository, source lives at `packages/buildstory-scanner` and the web app lives at `apps/buildstory-web`.

## Install

Requirements: Node.js 22.5+ and Git.

```powershell
npm install --global 'buildstory-scan'
buildstory-scan --version
```

Or run it without installing:

```powershell
npx buildstory-scan --version
```

From this source directory:

```powershell
Set-Location 'C:\path\to\buildstory\packages\buildstory-scanner'
npm ci
npm run build
npm install --global .

Get-Command buildstory-scan
buildstory-scan --version
```

For development, `npm link` can replace the global install:

```powershell
npm ci
npm run build
npm link
Get-Command buildstory-scan
```

Never advertise `npx buildstory` or `npx story-scanner`. Both names belong to
unrelated packages already on the public registry, so either would run someone
else's code. `buildstory-scan` is the only correct name — as the package, as
the binary, and as the `npx` target.

If PowerShell says `buildstory-scan` is not recognized, add npm's global command directory to this session:

```powershell
$npmGlobal = npm prefix --global
$env:Path = "$npmGlobal;$env:Path"
Get-Command buildstory-scan
buildstory-scan --version
```

If execution policy blocks npm's `.ps1` shim, run the generated `.cmd` shim:

```powershell
$buildstoryScan = Join-Path (npm prefix --global) 'buildstory-scan.cmd'
& $buildstoryScan --version
```

Source-tree fallback:

```powershell
node '.\dist\src\cli.js' --version
```

## Local dashboard workflow

These commands require a BuildStory web app running at the stated URL - a local loopback dev server by default, or the hosted app via `--remote`. Replace the example session values with the values displayed by that dashboard.

Stage 1 connects and stores a short-lived grant. It does **not** read a repository or upload a snapshot:

```powershell
$api = 'http://127.0.0.1:3000/'
buildstory-scan connect 'UPLOAD_SESSION_ID' --code 'DEVICE_CODE' --api-base-url $api
buildstory-scan status
```

Against the hosted app instead of a local dev server:

```powershell
buildstory-scan connect 'UPLOAD_SESSION_ID' --code 'DEVICE_CODE' --remote
buildstory-scan status
```

Stage 2 runs from the selected repository, requires separate scan and upload consent, validates locally, and performs the grant's single allowed `PUT`:

```powershell
Set-Location 'C:\path\to\selected-repository'
buildstory-scan scan-upload --repo . --consent local-scan --upload-consent local-dashboard
buildstory-scan status
```

Optional time bounds and an alternate Codex root remain available:

```powershell
buildstory-scan scan-upload --repo . `
  --codex-home 'C:\Users\me\.codex' `
  --since '2026-07-01T00:00:00Z' `
  --until '2026-08-01T00:00:00Z' `
  --consent local-scan `
  --upload-consent local-dashboard
```

The connect response grants exactly one snapshot `PUT`. After acceptance, the same bearer is retained locally only until expiry for authenticated, read-only status/report `GET`s. A second `scan-upload` is refused and requires a fresh dashboard connection. Browser cookies are omitted on every CLI request and never authorize CLI routes.

`http://localhost`, `http://127.x.x.x`, `http://[::1]`, and their HTTPS equivalents are always accepted. A non-loopback host is accepted only over HTTPS and only when `--allow-host` names its exact hostname (`--remote` sets both for the hosted origin). Redirects, embedded URL credentials, query strings, fragments, an unpinned or mismatched remote host, cross-origin grant URLs, and cross-origin status/report URLs fail closed.

### Mock mode

This in-process mode verifies installation and argument parsing only:

```powershell
buildstory-scan connect 'UPLOAD_SESSION_ID' --code 'DEVICE_CODE' --api-base-url 'mock://local'
```

It makes no network request, does not contact the dashboard, and creates no upload grant. A later `scan-upload` therefore fails with `UPLOAD_CONNECTION_REQUIRED`.

Common actionable errors:

- `CONNECT_ENDPOINT_REQUIRED`: pass the running web app URL with `--api-base-url`, or `--remote` for the hosted app.
- `CONNECT_ALLOW_HOST_REQUIRED` / `CONNECT_ALLOW_HOST_MISMATCH`: a non-loopback `--api-base-url` needs a matching `--allow-host`.
- `CONNECT_UNAVAILABLE`: start the local web app (or check connectivity to the remote host) and verify its port.
- `CONNECT_REJECTED`: copy a fresh session ID and device code from the dashboard.
- `UPLOAD_CONNECTION_REQUIRED`: complete a real connect; mock mode is not enough.
- `UPLOAD_UNAVAILABLE`: the grant was claimed before the attempted PUT; check the dashboard and reconnect before retrying.
- `UPLOAD_GRANT_ALREADY_USED`: use `buildstory-scan status` or connect again for another upload.

See [`docs/connect-protocol.md`](docs/connect-protocol.md) and [`docs/upload-lifecycle.md`](docs/upload-lifecycle.md) for the exact wire contract.

## Local-only inspect and scan

These commands never use a non-loopback network destination on their own. `inspect` is fully
offline; `scan` may call Ollama on loopback for local-first narrative prose and never sends
excerpts to a non-loopback model unless bring-your-own-key or cloud mode is explicitly
selected through a connected dashboard (see "Narrative modes" below):

```powershell
buildstory-scan inspect --repo 'C:\path\to\repository'
buildstory-scan scan --repo 'C:\path\to\repository' --consent local-scan --dry-run
buildstory-scan scan --repo 'C:\path\to\repository' --consent local-scan --output 'C:\outside-repository\project-snapshot.json'
```

`inspect` never opens AI session sources. `scan` requires `--consent local-scan`. Choose exactly one local output mode:

- `--dry-run` validates and prints the redacted payload without writing a file.
- `--output` atomically writes a mode-0600 file where supported. Its parent must exist outside the selected repository; replacing a file requires `--overwrite`.

Without an explicit end, the deterministic window uses the latest matched-session or HEAD-commit timestamp, then the Unix epoch. Without a start, it defaults to full observed history, starting at the earliest session. Identical inputs and options produce identical canonical bytes and scan IDs.

## Narrative modes

The connected dashboard chooses one of four narrative modes; the CLI reads it from the stored connection grant, and `--with-evidence`/`--require-evidence` can never override a `local`, `byok`, or `off` connection into uploading excerpts (a mismatch is refused with `NARRATIVE_MODE_CONFLICT`, not silently resolved).

- **Local** (the default): calls Ollama on loopback. Set `BUILDSTORY_OLLAMA_BASE_URL` to override the default `http://127.0.0.1:11434`.
- **Bring your own key (BYOK)**: calls an OpenAI-compatible cloud model you configure yourself, using `BUILDSTORY_BYOK_API_KEY` (required), `BUILDSTORY_BYOK_BASE_URL` (defaults to `https://api.openai.com/v1`), and optionally `BUILDSTORY_BYOK_MODEL`. Read only from the environment, never a CLI flag - a flag would land in shell history and process listings. Excerpts go from this machine directly to that provider, under that provider's own terms; Buildstory never sees them or the key. The resulting `generatedNarrative` reports `provider: "byok"` rather than the provider's hostname, since the uploaded snapshot's own fail-closed check rejects any field that looks like a URL or host.
- **Cloud**: requires `--with-evidence --review`; excerpts are uploaded to the connected Buildstory dashboard after you review and confirm them.
- **Off**: no narrative generation; only deterministic metrics and profile scores.

Local and BYOK both upload only `generatedNarrative` (never `narrativeEvidence`) and share the identical redaction/sanitization pipeline - only the HTTP destination for the model call differs.

## Contract and privacy boundary

- Portable schema: [`schema/project-snapshot.schema.json`](schema/project-snapshot.schema.json)
- TypeScript contract: [`src/contract.ts`](src/contract.ts)
- Content-free fixture: [`examples/project-snapshot.example.json`](examples/project-snapshot.example.json)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Privacy/redaction: [`docs/privacy.md`](docs/privacy.md)

The schema uses `additionalProperties: false` throughout. It cannot represent source/file bodies, diffs, patches, prompts, assistant responses, transcript bodies, tool arguments/results, commit subjects, author identities, absolute paths, raw remote URLs, or remote hosts. A remote-backed repository identity contains only opaque hashes.

The selected worktree is never opened for file-body reads. Git runs with optional locks disabled and returns identity plus status/history aggregates. Codex JSONL is streamed under file/line limits; content-bearing values are ignored and discarded after structural counts. Retained strings are bounded and redacted, then the complete canonical snapshot receives schema validation, forbidden-field checks, and fail-closed secret plus URL/host/path scans immediately before upload.

`--consent local-scan` authorizes only local collection. `--upload-consent local-dashboard` is separate, command-scoped consent for the already validated snapshot and only works with a live one-PUT grant from the connected dashboard (local or pinned remote). No background retry, telemetry, unpinned remote fallback, or pending snapshot queue exists.

## Dashboard command wording

Recommended PowerShell copy for the local demo:

```text
Install the CLI first (Node.js 22.5+):
  npm install --global "buildstory-scan"

With the local BuildStory web app running:
  buildstory-scan connect "UPLOAD_SESSION_ID" --code "DEVICE_CODE" --api-base-url "http://127.0.0.1:3000/"

From the selected Git repository:
  buildstory-scan scan-upload --repo . --consent local-scan --upload-consent local-dashboard

Then check the local result:
  buildstory-scan status
```

The `buildstory` and `story-scanner` binary aliases were removed before the first
publish: both names are already taken on npm by unrelated packages, so shipping
them would have made a global install collide with someone else's tool.
`buildstory-scan` is the only binary. Note that this is a distribution detail —
`provenance.scanner.name` in an emitted snapshot stays `buildstory`, because the
ProjectSnapshot schema pins it to an enum the server validates.

## Design references and provenance

The architecture was informed by, but does not copy or claim compatibility with:

- Y Combinator's official [Paxel overview](https://paxel.ycombinator.com/) and [technical data-handling documentation](https://paxel.ycombinator.com/data-handling): useful reference ideas include local Docker analysis, read-only repository mounting, repository/session consent controls, bounded/redacted outbound structures, and explicit source/transcript boundaries.
- [`staru09/open-paxel`](https://github.com/staru09/open-paxel), cited only as an independent third-party local-first implementation example.

No Paxel or Open Paxel implementation was copied, imported, or used as a dependency. BuildStory deliberately keeps a narrower payload: no raw transcript excerpts in the default snapshot, file paths, commit subjects, author details, remote hosts, raw remotes, non-loopback model calls in local mode, or source database. These references were reviewed on 2026-08-03 and are provenance context, not normative dependencies.

## Development and smoke tests

```powershell
npm ci
npm test
npm run test:e2e
npm pack
```

`npm test` includes a package smoke test that packs the package, installs it under a fresh npm prefix, invokes `buildstory-scan` through PowerShell, and asserts the retired `buildstory`/`story-scanner` aliases are absent. `npm run test:e2e` starts an ephemeral loopback HTTP server and verifies connect, canonical one-PUT upload, replay refusal, authenticated status/report GETs, and absence of repository paths, remote hosts, transcript bodies, and tool payloads from the wire body. Nothing is published or deployed.
