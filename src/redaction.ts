import type { RedactionCategory, RedactionSummary } from "./contract.js";
import { compareStrings } from "./canonical-json.js";

interface RedactionRule {
  category: RedactionCategory;
  pattern: RegExp;
  replacement?: (match: string) => string;
  knownSecret?: boolean;
}

const placeholder = (category: RedactionCategory): string => `[REDACTED:${category}]`;

const RULES: RedactionRule[] = [
  {
    category: "private-key",
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g,
    knownSecret: true,
  },
  { category: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, knownSecret: true },
  { category: "openai-key", pattern: /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{16,}\b/g, knownSecret: true },
  { category: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, knownSecret: true },
  { category: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, knownSecret: true },
  { category: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, knownSecret: true },
  { category: "slack-token", pattern: /\b(?:xox(?:a|b|p|r|s|c|d|o)-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/g, knownSecret: true },
  { category: "stripe-key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, knownSecret: true },
  { category: "twilio-key", pattern: /\b(?:AC|SK)[a-fA-F0-9]{32}\b/g, knownSecret: true },
  { category: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, knownSecret: true },
  { category: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, knownSecret: true },
  { category: "pypi-token", pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g, knownSecret: true },
  { category: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{25,}\b/g, knownSecret: true },
  { category: "cloudflare-token", pattern: /\b(?:cfoat|cfat|cfut|cfk)_[A-Za-z0-9_-]{16,}\b/g, knownSecret: true },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    knownSecret: true,
  },
  {
    category: "authorization",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: (match) => `${match.slice(0, match.indexOf(" "))} ${placeholder("authorization")}`,
    knownSecret: true,
  },
  {
    category: "credential-url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi,
    replacement: () => placeholder("credential-url"),
    knownSecret: true,
  },
  {
    category: "azure-storage-key",
    pattern: /\bAccountKey\s*=\s*[A-Za-z0-9+/=]{20,}/gi,
    replacement: () => `AccountKey=${placeholder("azure-storage-key")}`,
    knownSecret: true,
  },
  {
    category: "oauth-token",
    pattern: /\b(?:oauth_token|access_token|refresh_token)\s*=\s*[^\s,;&]{8,}/gi,
    replacement: () => placeholder("oauth-token"),
    knownSecret: true,
  },
  {
    category: "oauth-token",
    pattern: /\b1\/\/0[A-Za-z0-9_-]{16,}\b/g,
    knownSecret: true,
  },
  {
    category: "sensitive-assignment",
    pattern: /\b(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|auth[_-]?token|token|password|passwd|pwd|private[_-]?key|database[_-]?url|connection[_-]?string)\s*(?::|=)\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;&]{4,})/gi,
    knownSecret: true,
  },
  {
    category: "high-entropy",
    pattern: /\b[A-Za-z0-9+/_=-]{32,160}\b/g,
    replacement: (match) => (looksHighEntropy(match) ? placeholder("high-entropy") : match),
  },
];

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function looksHighEntropy(value: string): boolean {
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) return false;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) return false;
  if (value.includes("REDACTED")) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;

  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4.3;
}

export class Redactor {
  private readonly categoryCounts = new Map<RedactionCategory, number>();
  private scanned = 0;
  private truncated = 0;
  private transcriptBodiesDiscarded = 0;
  private toolPayloadsDiscarded = 0;

  public cleanMetadata(input: string, maxLength = 160): string {
    this.scanned += 1;
    const scanLimit = Math.max(maxLength * 4, 4_096);
    let output = input.length > scanLimit ? input.slice(0, scanLimit) : input;
    let wasTruncated = input.length > scanLimit;
    output = output.normalize("NFC");

    for (const rule of RULES) {
      output = output.replace(rule.pattern, (match) => {
        const replacement = rule.replacement?.(match) ?? placeholder(rule.category);
        if (replacement !== match) this.increment(rule.category);
        return replacement;
      });
    }

    output = output.replace(CONTROL_CHARACTERS, () => {
      this.increment("control-character");
      return "";
    });

    output = output.trim();
    if (output.length > maxLength) {
      wasTruncated = true;
      output = `${output.slice(0, Math.max(0, maxLength - 1))}…`;
    }
    if (wasTruncated) this.truncated += 1;
    return output || "unknown";
  }

  public recordTranscriptBodyDiscarded(count = 1): void {
    this.transcriptBodiesDiscarded += count;
  }

  public recordToolPayloadDiscarded(count = 1): void {
    this.toolPayloadsDiscarded += count;
  }

  public summary(finalLeakCheckPassed: true): RedactionSummary {
    const categories = [...this.categoryCounts.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([category, count]) => ({ category, count }));
    const findings = categories.reduce((sum, item) => sum + item.count, 0);

    return {
      applied: true,
      findings,
      categories,
      metadataValuesScanned: this.scanned,
      metadataValuesTruncated: this.truncated,
      transcriptBodiesDiscarded: this.transcriptBodiesDiscarded,
      toolPayloadsDiscarded: this.toolPayloadsDiscarded,
      finalLeakCheckPassed,
      limitations: [
        "Pattern matching cannot identify every secret, especially novel formats or low-entropy credentials.",
        "Repository names, branch names, tool names, and model names are metadata and may still be identifying after redaction.",
        "JSONL records are parsed in local process memory; transcript bodies and tool payloads are immediately discarded and never serialized.",
        "Opaque hashes prevent direct disclosure but can permit correlation, and low-entropy inputs may be guessable.",
      ],
    };
  }

  private increment(category: RedactionCategory): void {
    this.categoryCounts.set(category, (this.categoryCounts.get(category) ?? 0) + 1);
  }
}

export function detectKnownSecrets(value: string): RedactionCategory[] {
  const findings = new Set<RedactionCategory>();
  for (const rule of RULES) {
    if (!rule.knownSecret) continue;
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(value)) findings.add(rule.category);
    rule.pattern.lastIndex = 0;
  }
  return [...findings].sort(compareStrings);
}
