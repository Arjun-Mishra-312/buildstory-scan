# Privacy and redaction

## Data inventory

| Input | Read locally | Retained in snapshot | Sent to local web app |
| --- | --- | --- | --- |
| Repository files / source bodies | No | Never | Never |
| Diffs / patches | No | Never | Never |
| Git status paths | Counted transiently | Counts only | Counts only inside snapshot |
| Commit subjects / author identities | No subjects; author email hashed transiently for cardinality | Contributor count only | Count only |
| Raw remote URL and host | Canonicalized transiently | Opaque hashes only; no host | Hashes only |
| Codex prompts, responses, reasoning | JSON record materialized locally; content ignored | Never; discard count only | Never |
| Tool arguments and results | JSON record materialized locally; content ignored | Never; discard count only | Never |
| Session identifiers / absolute paths | Used for scoping and hashing | Opaque refs only | Opaque refs only |
| Timestamps, lifecycle kinds, model/tool names, token counts | Yes | Bounded/redacted metadata and aggregates | Validated snapshot fields only |
| Upload-session ID / device code | Connect only | Never | Exact values in connect POST only |
| One-use bearer | Connect response and local protected state | Never | Authorization header on one PUT and bounded GETs |
| Status/report response | Status only | Never | Received from local web app; no source snapshot returned |

`inspect` and `scan` never call the network. `inspect` does not read Codex roots. `scan` will not read them until the exact `--consent local-scan` is present.

`connect` is a separate control plane. Mock mode contacts nothing. Real mode contacts only an explicit loopback API, or one explicit HTTPS host confirmed via `--allow-host`/`--remote`, and sends the bounded request in [`connect-protocol.md`](connect-protocol.md). It does not read a repository or snapshot. The upload-session ID and device code are kept only in process memory and the POST body, never printed, logged, hashed, or persisted. Because `--code` can remain in PowerShell history or privileged process listings, dashboard codes must be short-lived and one-use.

`scan-upload` is the only data plane. It requires both local-scan and local-dashboard upload consent, then sends only the already validated canonical `ProjectSnapshot`. No raw input, adapter object, repository path, environment dump, error detail, cookie, multipart attachment, or wrapper object can reach the transport API.

The bearer is stored only in platform-local state with mode 0600 where supported. It authorizes one snapshot PUT. After verified acceptance, it remains only for authenticated GET status/report calls until its short expiry; local state marks the PUT as used, so the CLI cannot repeat it. A failed/ambiguous upload attempt consumes local PUT state and is never retried silently.

## Redaction and fail-closed checks

Every retained free-form snapshot string passes through normalization, control-character removal, a maximum length, and pattern rules for:

- PEM private keys and authorization headers;
- Anthropic/OpenAI, AWS, GitHub, GitLab, Slack, Stripe, Twilio, Hugging Face, npm, PyPI, Google, and Cloudflare credential formats;
- JWTs, OAuth tokens, Azure storage keys, credential-bearing URLs, common secret/password assignments;
- conservative high-entropy candidates.

Replacements are category-only markers such as `[REDACTED:github-token]`, never secret-derived hashes. The assembled snapshot is validated against the strict JSON Schema, traversed for forbidden content-bearing keys, canonicalized, and scanned again for known secret formats plus raw URLs, hosts, and paths. A finding aborts before grant claim or network access.

Status report summaries are untrusted local-API data. They are size/type checked and redacted again before terminal output. Errors never print server response bodies.

## Limits and residual risk

Pattern and entropy rules cannot identify every credential, particularly new formats or memorable/low-entropy secrets. Repository display names, branch names, model/tool names, timestamps, aggregate behavior, and stable hashes can identify or correlate a person or private project. A repository-path hash based on low-entropy input can be guessable.

Codex stores content and metadata together. Parsing a matched JSONL record necessarily materializes the local JSON value in process memory, although content-bearing properties are not interpreted, retained, logged, cached, or serialized. JavaScript does not guarantee immediate memory zeroization. Oversized or malformed records are skipped with content-free warnings.

`git status` necessarily returns file names to the local Git child process before the scanner counts them. The scanner never serializes or logs those names. The read commands do not intentionally invoke hooks or contact remotes and no fetch occurs, but unusual user Git configuration and OS access-time behavior remain outside the scanner's control.

Dry-run prints the complete redacted snapshot; terminal capture and shell redirection are the user's responsibility. Mode bits are best effort on Windows. Disk encryption, backups, malware, privileged local users, and secure deletion are outside this boundary. Loopback limits exposure but does not make an untrusted local process safe; users must run the intended local BuildStory web app.

Redaction reduces risk; it does not prove anonymity.

## Relationship to references

Y Combinator's [Paxel data-handling documentation](https://paxel.ycombinator.com/data-handling) is a useful disclosure model for local processing, a read-only repository boundary, bounded derived payloads, redaction, source/transcript separation, and consent controls. BuildStory does not adopt Paxel's excerpt, path, commit-metadata, LLM, telemetry, storage, or remote-upload behavior.

The independent [`staru09/open-paxel`](https://github.com/staru09/open-paxel) repository is cited only as a third-party local-first example. No implementation was inspected for copying, imported, or reused.
