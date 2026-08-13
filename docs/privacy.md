# Privacy and redaction

## Data inventory

| Input | Read locally | Retained in snapshot | Sent to local web app |
| --- | --- | --- | --- |
| Repository files / source bodies | No | Never | Never |
| Diffs / patches | No | Never | Never |
| Git status paths | Counted transiently | Counts only | Counts only inside snapshot |
| Commit subjects / author identities | No subjects; author email hashed transiently for cardinality | Contributor count only | Count only |
| Raw remote URL and host | Canonicalized transiently | Opaque hashes only; no host | Hashes only |
| AI session prompts, responses, reasoning (Codex, Claude Code, Cursor, Google Antigravity) | JSON/SQLite record materialized locally; content-bearing fields discarded by default; selected narrative candidates read only in an opted-in narrative path | Never in raw form; reviewed, redacted excerpts only in `narrativeEvidence` for Cloud mode | Never in raw form; Cloud mode uploads only the reviewed, redacted excerpt bundle |
| Tool arguments and results | JSON record materialized locally; content ignored | Never; discard count only | Never |
| Session identifiers / absolute paths | Used for scoping and hashing | Opaque refs only | Opaque refs only |
| Timestamps, lifecycle kinds, model/tool names, token counts | Yes | Bounded/redacted metadata and aggregates | Validated snapshot fields only |
| Upload-session ID / device code | Connect only | Never | Exact values in connect POST only |
| One-use bearer | Connect response and local protected state | Never | Authorization header on one PUT and bounded GETs |
| Status/report response | Status only | Never | Received from local web app; no source snapshot returned |
| BYOK API key (`BUILDSTORY_OPENROUTER_API_KEY`, `BUILDSTORY_OPENAI_API_KEY`, or legacy `BUILDSTORY_BYOK_API_KEY`) | Read from the environment only, never a CLI flag | Never | Never - sent only as the Authorization header on the creator's own request to their configured provider, which is not a Buildstory endpoint |
| BYOK model input | Deterministic facts plus selected/redacted excerpts are shown in an exact pre-send CLI review | Never | After typed confirmation, sent only to the creator's configured provider, never to Buildstory |

`inspect` never calls the network. `scan` will not read session roots until the exact `--consent local-scan` is present. Local mode sends selected excerpts only to loopback Ollama. Its standard-depth evidence profile adapts to available RAM and logical CPUs, selecting up to 40, 64, or 80 excerpts; this capability is available on both plans. BYOK requires `--review` and typed confirmation before it sends anything to the provider. The review shows the cleaned repository label; session, turn, tool-call, Git-change, and work-pattern aggregates; model name; archetype rationale; score values, raw inputs and formulas; and every selected redacted excerpt. Standard BYOK is capped at 80 excerpts/800 characters each/60,000 characters total. Deep BYOK is capped at 400 excerpts/1,500 characters each/700 KiB total, dynamically reduced to remain below the upload grant, and uses a private analysis pass followed by V3 synthesis. Each component may make one bounded repair request if its JSON is invalid. The requests go directly to OpenRouter or OpenAI, not to Buildstory; Buildstory receives only the sanitized finished report and a content-free receipt.

`connect` is a separate control plane. Mock mode contacts nothing. Real mode contacts only an explicit loopback API, or one explicit HTTPS host confirmed via `--allow-host`/`--remote`, and sends the bounded request in [`connect-protocol.md`](connect-protocol.md). It does not read a repository or snapshot. The upload-session ID and device code are kept only in process memory and the POST body, never printed, logged, hashed, or persisted. Because `--code` can remain in PowerShell history or privileged process listings, dashboard codes must be short-lived and one-use.

`scan-upload` is the only non-loopback Buildstory data plane. It requires both local-scan and local-dashboard upload consent, then sends only the already validated canonical `ProjectSnapshot`. In local and BYOK mode the Buildstory upload can contain `generatedNarrative`, but never `narrativeEvidence`; BYOK's separate, pre-confirmed provider requests contain only the facts and excerpts printed by its review. In Buildstory Cloud mode the reviewed, redacted `narrativeEvidence` excerpts are the explicit opt-in exception: standard is capped at 80 excerpts/800 characters each/60,000 characters total; deep is capped at 400 excerpts/1,500 characters each/700 KiB total, dynamically reduced within the 1 MiB upload ceiling. Standard generation uses one request and at most one JSON-repair request. Deep generation sends the excerpts in its analysis request (and at most one repair). Synthesis and its possible repair do not directly include the excerpt strings, but do receive deterministic facts, source metadata, and a model-produced analysis map that can summarize excerpt content. A dashboard-selected mode is authoritative for the whole connection: `--with-evidence` can never override a local, BYOK, or off connection into uploading excerpts - a mismatch is refused (`NARRATIVE_MODE_CONFLICT`) rather than silently resolved. No raw input, adapter object, repository path, environment dump, error detail, cookie, multipart attachment, wrapper object, or BYOK API key can reach the Buildstory transport API.

The bearer is stored only in platform-local state with mode 0600 where supported. It authorizes one server-side snapshot PUT. After verified acceptance, it remains only for authenticated GET status/report calls until its short expiry; local state marks the PUT as used. The CLI never retries an upload automatically. Network errors and designated retryable HTTP statuses can restore the local grant for a manual retry, but an ambiguously accepted server-side grant remains one-use and the server will refuse its replay.

## Redaction and fail-closed checks

Every retained free-form snapshot string passes through normalization, control-character removal, a maximum length, and pattern rules for:

- PEM private keys and authorization headers;
- Anthropic/OpenAI, AWS, GitHub, GitLab, Slack, Stripe, Twilio, Hugging Face, npm, PyPI, Google, and Cloudflare credential formats;
- JWTs, OAuth tokens, Azure storage keys, credential-bearing URLs, common secret/password assignments;
- conservative high-entropy candidates.

Opted-in narrative excerpts also replace recognized email addresses, remote URLs, common and selected country/new top-level-domain hosts, and quoted or unquoted absolute/relative paths (including quoted paths containing spaces).

Replacements are category-only markers such as `[REDACTED:github-token]`, never secret-derived hashes. The assembled snapshot is validated against the strict JSON Schema, traversed for forbidden content-bearing keys, canonicalized, and scanned again for known secret formats plus raw URLs, hosts, and paths. A finding aborts before grant claim or network access.

Status report summaries are untrusted local-API data. They are size/type checked and redacted again before terminal output. Errors never print server response bodies.

## Limits and residual risk

Pattern and entropy rules cannot identify every credential, personal name, proprietary idea, pasted source fragment, or identifying detail, particularly new formats and memorable/low-entropy secrets. Repository display names, branch names, model/tool names, timestamps, aggregate behavior, and stable hashes can identify or correlate a person or private project. A repository-path hash based on low-entropy input can be guessable. The optional `timeWindow.utcOffsetMinutes` is a coarse local-time hint: it contains no location name, but it is still a small privacy trade and is omitted when unavailable.

Every supported source (Codex, Claude Code, and Cursor's JSONL/SQLite records; Google Antigravity's installed-app detection) stores content and metadata together. Parsing a matched record necessarily materializes the local JSON or row value in process memory, although content-bearing properties are not interpreted, retained, logged, cached, or serialized. JavaScript does not guarantee immediate memory zeroization. Oversized or malformed records are skipped with content-free warnings. Cursor and Google Antigravity are best-effort, format-unverified adapters (see `ProviderSelection.diagnostic` and the `PROVIDER_FORMAT_UNVERIFIED` quality warning) - the same content-boundary guarantee applies to them, but their parsing logic has not been confirmed against a real installation.

`git status` necessarily returns file names to the local Git child process before the scanner counts them. The scanner never serializes or logs those names. The read commands do not intentionally invoke hooks or contact remotes and no fetch occurs, but unusual user Git configuration and OS access-time behavior remain outside the scanner's control.

Dry-run prints the complete redacted snapshot; terminal capture and shell redirection are the user's responsibility. Mode bits are best effort on Windows. Disk encryption, backups, malware, privileged local users, and secure deletion are outside this boundary. Loopback limits exposure but does not make an untrusted local process safe; users must run the intended local BuildStory web app.

Redaction reduces risk; it does not prove anonymity.

## Relationship to references

Y Combinator's [Paxel data-handling documentation](https://paxel.ycombinator.com/data-handling) is a useful disclosure model for local processing, a read-only repository boundary, bounded derived payloads, redaction, source/transcript separation, and consent controls. BuildStory does not adopt Paxel's excerpt, path, commit-metadata, LLM, telemetry, storage, or remote-upload behavior.

The independent [`staru09/open-paxel`](https://github.com/staru09/open-paxel) repository is cited only as a third-party local-first example. No implementation was inspected for copying, imported, or reused.
