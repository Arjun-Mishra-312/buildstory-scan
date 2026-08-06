# Adding a local coding-agent provider

This scanner reads local, repository-scoped session history from installed
coding agents (Codex, Claude Code, Cursor, Google Antigravity, and future
tools) without the report pipeline or any LLM needing to understand each
tool's transcript format. A new provider is a small, reviewed, built-in
adapter - never loaded dynamically from a user's machine.

## Checklist

A provider is only added to `sources/registry.ts` once it has all of the
following:

1. **A bounded local discovery strategy.** Identify the documented or
   community-verified local session root(s) for Windows, macOS, and Linux,
   plus an explicit override option (see `codexHome`/`claudeCodeHome`/
   `cursorHome`/`antigravityHome` for the existing pattern). Do research
   before writing a parser - if no reliable format documentation exists,
   ship a **detection-only** adapter instead (see
   `sources/gemini-antigravity.ts`): report installed vs. not-installed,
   always zero sessions, `capabilities.metadata: false`. Never claim support
   merely because an application directory exists.
2. **Repository-scope enforcement.** Reuse `relationToRepository` from
   `sources/path-scope.ts` wherever the provider records an absolute working
   directory. If no safe scope can be established for an item, skip it -
   never guess scope from a project name alone.
3. **A versioned parser.** Reuse `consumeJsonLines` (streaming, 4 MiB
   line / bounded) for JSONL formats. Every numeric safety limit (file size,
   line size, event count, directory depth, session count) must be an
   explicit named constant, matching `codex.ts`/`claude-code.ts`/`cursor.ts`.
   Tag `descriptor.formatVersions` with `"unverified-..."` until a real local
   installation confirms the format; keep emitting a content-free
   `PROVIDER_FORMAT_UNVERIFIED` warning for as long as that's true.
4. **Redaction and privacy fixtures.** Never persist raw provider records,
   tool arguments/results, file bodies, diffs, or credentials. All narrative
   text passes through the shared selector's single call to
   `Redactor.cleanExcerpt` (`sources/narrative-evidence.ts`) - adapters never
   call the redactor for excerpt text themselves.
5. **A deterministic evidence extractor.** Implement `readEvents` (emits
   `NormalizedConversationEvent[]`, the shared internal shape - never
   serialized) and `extractCandidates` (recognizes session-title,
   user-intent, plan-transition, assistant-decision, outcome from those
   events, then calls `orderSessionCandidates` to cap/dedupe/order them).
   Both are optional; omit both if `capabilities.narrativeEvidence` is
   `false`.
6. **Documentation of what is and is not read.** A one-paragraph comment at
   the top of the adapter file, matching the style in `cursor.ts` and
   `gemini-antigravity.ts`, stating exactly what was verified vs. guessed.

## Wiring

- Add the id to `ProviderId` in `src/contract.ts` **and** the mirrored copy
  in `apps/buildstory-web/lib/ingestion/scanner-project-snapshot.ts`, kept in
  lockstep by hand (there is no codegen link between them).
- Add the id everywhere the JSON Schema enumerates providers
  (`schema/project-snapshot.schema.json`: `sourceSelection.providers[].provider`,
  `session.provider`, `evidence.source`) and its web mirror.
- Add one factory entry to `REGISTRY` in `sources/registry.ts`. Nothing in
  `scanner.ts` or `cli.ts` should hardcode a provider list outside that file.
- If the provider can contribute real metrics, it becomes part of the
  default `--source all` selection automatically (any adapter with
  `capabilities.metadata: true`). A detection-only adapter never does
  and stays explicitly opt-in.

## Test checklist

One fixture suite per provider and format version, covering: a matching
session, an unrelated-repository session, a malformed record, an oversized
record, a format-version mismatch, and (for narrative-evidence-capable
adapters) title/intent/decision/turning-point/outcome extraction plus
redaction of secrets/URLs/hosts/paths in every excerpt.
