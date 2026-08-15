const TOKEN_MAGNITUDES: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "K"],
];

export function formatTokens(total: number): string {
  for (const [threshold, suffix] of TOKEN_MAGNITUDES) {
    if (total >= threshold) return `${(total / threshold).toFixed(1)}${suffix}`;
  }
  return String(total);
}

export function formatUsd(microUsd: number | null): string {
  if (microUsd === null) return "not priced";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

export function wrap(text: string, width: number): string[] {
  const limit = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  for (const word of words) {
    if (word.length > limit) {
      flush();
      for (let index = 0; index < word.length; index += limit) {
        lines.push(word.slice(index, index + limit));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > limit && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  flush();
  return lines.length ? lines : [""];
}

export function studioReportUrl(apiOrigin: string, reportUrl: string | null): string | null {
  if (!reportUrl) return `${apiOrigin.replace(/\/$/, "")}/studio`;
  try {
    const parsed = new URL(reportUrl);
    const match = /\/api\/v1\/cli\/reports\/([^/?#]+)/.exec(parsed.pathname);
    if (!match?.[1]) return `${parsed.origin}/studio`;
    return `${parsed.origin}/studio/reports/${match[1]}`;
  } catch {
    return null;
  }
}
