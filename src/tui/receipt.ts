import type { ProjectSnapshot } from "../contract.js";
import { reportSignals, snapshotStoryPack } from "../exporters/report.js";
import { computeBuilderProfile } from "../insights/profile.js";
import type { WrittenReportFiles } from "../exporters/write-report.js";
import { formatTokens } from "./format.js";

export function renderCompactReceipt(snapshot: ProjectSnapshot, files: WrittenReportFiles, mode: string): string {
  const pack = snapshotStoryPack(snapshot);
  const profile = computeBuilderProfile({
    sessions: snapshot.sessions,
    usage: snapshot.usage,
    git: snapshot.git,
    timeWindow: snapshot.timeWindow,
  });
  const signals = reportSignals(snapshot).slice(0, 3);
  const tokens = snapshot.usage.tokenUsage?.totalTokens ?? 0;
  const lines = [
    "",
    pack?.hero.headline ?? snapshot.repository.displayName,
    pack?.hero.summary ?? `${snapshot.sessions.length} sessions · ${snapshot.git.commits} commits · ${profile.archetype.name}`,
    "",
    `${snapshot.sessions.length} sessions   ${snapshot.git.commits} commits   ${tokens ? formatTokens(tokens) : "—"} tokens   ${mode}`,
    ...signals.map((signal) => `  ${signal.headline}`),
    "",
    `Wrote ${files.directory}`,
    "  report.json  report.md  report.html",
    "",
    "Open in BuildStory when you want a private hosted copy",
    "",
  ];
  return lines.join("\n");
}
