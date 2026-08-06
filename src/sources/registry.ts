import type { ProviderId } from "../contract.js";
import { ClaudeCodeSessionAdapter } from "./claude-code.js";
import { CodexSessionAdapter } from "./codex.js";
import { CursorSessionAdapter } from "./cursor.js";
import { GeminiAntigravitySessionAdapter } from "./gemini-antigravity.js";
import type { SessionProviderAdapter } from "./types.js";

/**
 * The single place every built-in provider adapter is registered. Adding a
 * provider means adding one factory here (plus the ProviderId/SessionFormat
 * union entries in contract.ts and the schema) - nothing else in scanner.ts
 * or cli.ts should hardcode a provider list. See docs/adding-a-provider.md
 * for the full checklist a new adapter needs before it belongs here.
 */
export interface ProviderAdapterOptions {
  codexHome?: string;
  claudeCodeHome?: string;
  antigravityHome?: string;
  cursorHome?: string;
}

const REGISTRY: ReadonlyArray<{ id: ProviderId; create: (options: ProviderAdapterOptions) => SessionProviderAdapter }> = [
  { id: "claude-code", create: (options) => new ClaudeCodeSessionAdapter(options.claudeCodeHome ? { claudeCodeHome: options.claudeCodeHome } : {}) },
  { id: "codex", create: (options) => new CodexSessionAdapter(options.codexHome ? { codexHome: options.codexHome } : {}) },
  { id: "cursor", create: (options) => new CursorSessionAdapter(options.cursorHome ? { cursorHome: options.cursorHome } : {}) },
  {
    id: "gemini-antigravity",
    create: (options) => new GeminiAntigravitySessionAdapter(options.antigravityHome ? { antigravityHome: options.antigravityHome } : {}),
  },
];

/** Every provider id this scanner build knows how to construct an adapter for, sorted for deterministic default ordering. */
export const REGISTERED_PROVIDER_IDS: readonly ProviderId[] = REGISTRY.map((entry) => entry.id)
  .slice()
  .sort();

/**
 * Providers selectable by default when a scan doesn't pass an explicit
 * `--source` list - only adapters whose descriptor declares
 * capabilities.metadata. A detection-only adapter (e.g. Gemini Antigravity
 * today) stays registered and explicitly selectable, but never silently
 * appears as a false-positive "scanned" provider in a default run.
 */
export function defaultProviderIds(): ProviderId[] {
  return REGISTRY.filter((entry) => entry.create({}).descriptor.capabilities.metadata)
    .map((entry) => entry.id)
    .sort();
}

export function isRegisteredProvider(id: string): id is ProviderId {
  return REGISTRY.some((entry) => entry.id === id);
}

export function createAdapter(id: ProviderId, options: ProviderAdapterOptions): SessionProviderAdapter {
  const entry = REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`No registered adapter for provider "${id}".`);
  }
  return entry.create(options);
}

export function createAdapters(ids: ProviderId[], options: ProviderAdapterOptions): SessionProviderAdapter[] {
  return ids.map((id) => createAdapter(id, options));
}
