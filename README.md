# buildstory-scan

Turn AI-assisted Git work into the story of how it was built — on your machine.

```text
npx buildstory-scan generate --repo . --consent local-scan
```

The part that reads your machine is inspectable and self-hostable. You can generate a BuildStory report without an account. [BuildStory.com](https://buildstory.dev) is the hosted renderer, history, and community for that same report.

```text
✓ Inspected repository
✓ Discovered Codex / Claude Code / Cursor
✓ Parsed sessions
✓ Generated story

Wrote ./buildstory/report.json
      ./buildstory/report.md
      ./buildstory/report.html
```

On a terminal, `generate` opens an interactive dashboard (story, receipt, sessions, signals, evidence). Piped or CI runs write the same files and print a compact receipt (`--json` / `--no-tui`).

## What it reads — and what it never reads

Reads, after `--consent local-scan`:

- Git aggregates (commit / insertion / deletion counts, not subjects or diffs)
- Supported local AI-session metadata from Codex, Claude Code, Cursor, and Google Antigravity

Never reads:

- Source-file bodies
- Diffs or patches
- Commit subjects or author identities as public content
- Raw remote URLs (opaque hashes only)

You do not have to trust a black box. This repository is the engine.

## Install

Node.js 22.5+ and Git.

```powershell
npm install --global buildstory-scan
buildstory-scan --version
```

Or run without installing:

```powershell
npx buildstory-scan --version
```

`buildstory` and `story-scanner` are unrelated packages on npm. **`buildstory-scan` is the only correct name** — as the package, as the binary, and as the `npx` target.

## Generate a local report

From a Git repository:

```powershell
npx buildstory-scan generate --repo . --consent local-scan
```

Defaults to local Ollama on loopback. If `BUILDSTORY_OPENROUTER_API_KEY` or `BUILDSTORY_OPENAI_API_KEY` is set, generate uses that provider instead. Pass `--local` to force Ollama, or `--off` for a metrics-only report.

Nothing is sent to Buildstory during `generate`.

Inside a Git worktree, `npx buildstory-scan` with no command starts generate in the TUI and asks for scan consent there.

## Optional: open the report on BuildStory.dev

`connect` / `scan-upload` remain available when you want GitHub integration, report history, publishing, and the hosted UI. They are optional.

```powershell
buildstory-scan connect 'UPLOAD_SESSION_ID' --code 'DEVICE_CODE' --remote
buildstory-scan scan-upload --repo . --consent local-scan --upload-consent local-dashboard
```

## Library

Cloudflare Workers and other hosts can import the fetch-only engine without git or the CLI:

```ts
import { buildCombinedMessages, computeBuilderProfile, computeSignals } from "buildstory-scan/engine";
```

## Contract and privacy

- Portable schema: [`schema/project-snapshot.schema.json`](schema/project-snapshot.schema.json)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Privacy / redaction: [`docs/privacy.md`](docs/privacy.md)

## License

MIT
