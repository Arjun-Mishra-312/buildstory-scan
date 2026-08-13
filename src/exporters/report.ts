import type { ProjectSnapshot, ReportStoryPack, Signal } from "../contract.js";
import { computeBuilderProfile } from "../insights/profile.js";
import { computeSignals } from "../insights/signals.js";
import { buildStoryPackSources } from "../narrative/story-pack.js";

function activeDays(snapshot: ProjectSnapshot): number {
  return new Set(snapshot.sessions.map((session) => session.startedAt.slice(0, 10))).size;
}

function formatUsd(microUsd: number | null): string {
  if (microUsd === null) return "not priced";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000_000) return `${(total / 1_000_000_000).toFixed(1)}B`;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(total);
}

export function reportSignals(snapshot: ProjectSnapshot): Signal[] {
  const pack = snapshot.generatedNarrative?.storyPack;
  if (pack?.signals?.length) return pack.signals;
  return computeSignals({
    sessions: snapshot.sessions,
    usage: snapshot.usage,
    git: snapshot.git,
    timeWindow: snapshot.timeWindow,
    narrativeEvidence: snapshot.narrativeEvidence,
    sources: buildStoryPackSources(snapshot, snapshot.narrativeEvidence?.excerpts ?? []),
  });
}

export function snapshotStoryPack(snapshot: ProjectSnapshot): ReportStoryPack | undefined {
  return snapshot.generatedNarrative?.storyPack;
}

export function renderMarkdownReport(snapshot: ProjectSnapshot): string {
  const profile = computeBuilderProfile({
    sessions: snapshot.sessions,
    usage: snapshot.usage,
    git: snapshot.git,
    timeWindow: snapshot.timeWindow,
  });
  const pack = snapshotStoryPack(snapshot);
  const signals = reportSignals(snapshot);
  const tokens = snapshot.usage.tokenUsage?.totalTokens ?? 0;
  const lines = [
    `# ${pack?.hero.headline ?? snapshot.repository.displayName}`,
    "",
    pack?.hero.summary ?? snapshot.generatedNarrative?.sections.narrative ?? "A local BuildStory report of observed AI-assisted work.",
    "",
    "## Receipt",
    "",
    `- Repository: ${snapshot.repository.displayName}`,
    `- Window: ${snapshot.timeWindow.start} → ${snapshot.timeWindow.end}`,
    `- Sessions: ${snapshot.sessions.length}`,
    `- Active days: ${activeDays(snapshot)}`,
    `- Commits: ${snapshot.git.commits}`,
    `- Tokens: ${tokens ? formatTokens(tokens) : "not collected"}`,
    `- Estimated cost: ${formatUsd(snapshot.usage.cost.totalMicroUsd)}`,
    `- Archetype: ${profile.archetype.name}`,
    `- Narrative: ${snapshot.generatedNarrative ? `${snapshot.generatedNarrative.provider} (${snapshot.generatedNarrative.model})` : "off — metrics only"}`,
    "",
  ];
  if (pack) {
    lines.push("## Build arc", "");
    for (const phase of pack.buildArc) {
      lines.push(`### ${phase.phase}: ${phase.headline}`, "", phase.summary, "");
    }
    lines.push("## Turning point", "", pack.turningPoint.quote, "", "## Moments", "");
    for (const moment of pack.moments) {
      lines.push(`### ${moment.title}`, "", moment.whatHappened, "", moment.whyItMattered, "");
    }
  }
  if (signals.length) {
    lines.push("## By the numbers", "");
    for (const signal of signals) {
      lines.push(`- **${signal.headline}** — ${signal.detail}`);
    }
    lines.push("");
  }
  lines.push(
    "---",
    "",
    "Generated locally by [buildstory-scan](https://github.com/Arjun-Mishra-312/buildstory-scan). Source files and diffs were not read.",
    "",
    "Want the interactive version, publish controls, and chapters? [Open in BuildStory](https://buildstory.dev)",
    "",
  );
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderHtmlReport(snapshot: ProjectSnapshot): string {
  const markdownish = renderMarkdownReport(snapshot);
  const pack = snapshotStoryPack(snapshot);
  const title = escapeHtml(pack?.hero.headline ?? snapshot.repository.displayName);
  const body = escapeHtml(markdownish);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — BuildStory</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0 auto; max-width: 44rem; padding: 2.5rem 1.25rem 4rem; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
    pre { white-space: pre-wrap; font: inherit; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid currentColor; opacity: 0.7; }
    a { color: inherit; }
  </style>
</head>
<body>
  <pre>${body}</pre>
  <footer>
    Interactive version, publish, and chapters → <a href="https://buildstory.dev">buildstory.dev</a>
  </footer>
</body>
</html>
`;
}
