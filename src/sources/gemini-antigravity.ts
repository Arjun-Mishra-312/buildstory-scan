import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { QualityWarning } from "../contract.js";
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
  ProviderDiscoveryResult,
  SessionProviderAdapter,
} from "./types.js";

/**
 * Detection-only adapter for Google Antigravity (the agentic IDE built on
 * Gemini, not the "Gemini CLI"). Research (2026-08) confirmed a local
 * per-conversation directory layout - `$HOME/.gemini/antigravity/brain/
 * <conversation-id>/{implementation_plan.md,task.md,walkthrough.md}` - but
 * found no documented or community-verified schema for the actual
 * conversation transcript, timestamps, model identifiers, or a
 * repository-scoping field comparable to Codex's `cwd`/Claude Code's `cwd`.
 * The "brain" markdown files are agent-authored planning artifacts, not a
 * verified verbatim transcript, so this adapter deliberately does not parse
 * them: per the plan's own safety rule, an adapter must not claim support
 * merely because an application directory exists. It reports installed vs.
 * not-installed and always zero sessions, with a content-free diagnostic
 * explaining why, rather than guessing at an unverified format.
 */

export interface GeminiAntigravityAdapterOptions {
  antigravityHome?: string;
}

export class GeminiAntigravitySessionAdapter implements SessionProviderAdapter {
  public readonly provider = "gemini-antigravity" as const;
  public readonly sessionFormat = "gemini-antigravity-jsonl" as const;
  public readonly descriptor: ProviderDescriptor = {
    id: "gemini-antigravity",
    displayName: "Gemini Antigravity",
    sessionFormat: "gemini-antigravity-jsonl",
    // Detection-only: no confirmed local transcript format to parse yet.
    capabilities: { metadata: false, narrativeEvidence: false },
    formatVersions: ["unverified-format-not-yet-researched-enough-to-parse"],
  };
  private readonly homeDirectory: string;

  public constructor(options: GeminiAntigravityAdapterOptions = {}) {
    this.homeDirectory = options.antigravityHome ?? process.env.ANTIGRAVITY_HOME ?? path.join(os.homedir(), ".gemini", "antigravity");
  }

  public async discover(_context: ProviderDiscoveryContext): Promise<ProviderDiscoveryResult> {
    const warnings: QualityWarning[] = [];
    let installed = false;
    try {
      const stat = await lstat(this.homeDirectory);
      installed = stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      installed = false;
    }

    if (!installed) {
      warnings.push({
        code: "GEMINI_ANTIGRAVITY_ROOT_UNAVAILABLE",
        severity: "info",
        message: "Google Antigravity's local data directory was not found; treated as not installed.",
      });
    } else {
      warnings.push({
        code: "PROVIDER_FORMAT_UNVERIFIED",
        severity: "info",
        message: "Google Antigravity is installed, but its local conversation format is not yet verified; no sessions were read.",
      });
    }

    return {
      provider: "gemini-antigravity",
      sessionFormat: "gemini-antigravity-jsonl",
      rootsConsidered: 1,
      filesDiscovered: 0,
      filesParsed: 0,
      filesSkipped: 0,
      sessionsMatched: 0,
      sessions: [],
      warnings,
    };
  }
}
