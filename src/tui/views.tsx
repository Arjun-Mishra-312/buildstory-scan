import React from "react";
import { Box, Text } from "ink";
import type { ProjectSnapshot } from "../contract.js";
import { reportSignals, snapshotStoryPack } from "../exporters/report.js";
import { computeBuilderProfile } from "../insights/profile.js";
import { formatTokens, formatUsd, wrap } from "./format.js";
import {
  barWidth,
  dailySpendSeries,
  modelSpendShare,
  receiptTiles,
  sessionHourSparkline,
  truncateModelName,
} from "./receipt-metrics.js";
import { theme } from "./theme.js";

function terminalWidth(): number {
  return Math.max(40, (process.stdout.columns ?? 80) - 8);
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.muted} paddingX={1} width={28} marginRight={1} marginBottom={0}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{value}</Text>
    </Box>
  );
}

export function StoryView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const pack = snapshotStoryPack(snapshot);
  const width = terminalWidth();
  if (!pack) {
    return <Text dimColor>Metrics-only report. No narrative was generated.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>{pack.hero.headline}</Text>
      <Box height={1}><Text> </Text></Box>
      {wrap(pack.hero.summary, width).map((line, index) => <Text key={`s-${index}`}>{line}</Text>)}
      <Box height={1}><Text> </Text></Box>
      {pack.buildArc.map((phase) => (
        <Box key={phase.phase} flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={theme.warning} bold>{phase.phase.toUpperCase()}</Text>
            <Text>  {phase.headline}</Text>
          </Text>
          {wrap(phase.summary, width).map((line, index) => (
            <Text key={`${phase.phase}-${index}`} dimColor>{line}</Text>
          ))}
        </Box>
      ))}
      <Text bold color={theme.success}>Turning point</Text>
      {wrap(pack.turningPoint.quote, width).map((line, index) => <Text key={`tp-${index}`}>{line}</Text>)}
      <Box height={1}><Text> </Text></Box>
      <Text dimColor>3 Sessions · 4 Signals · 5 Evidence are on this machine too</Text>
      <Text dimColor>Publish or share is on the site if you want it — not required.</Text>
    </Box>
  );
}

export function ReceiptView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const profile = computeBuilderProfile({
    sessions: snapshot.sessions,
    usage: snapshot.usage,
    git: snapshot.git,
    timeWindow: snapshot.timeWindow,
  });
  const tiles = receiptTiles(snapshot);
  const share = modelSpendShare(snapshot);
  const series = dailySpendSeries(snapshot);
  const peakSpend = Math.max(0, ...series.columns.map((column) => column.spendMicroUsd));
  const peakSessions = Math.max(1, ...series.columns.map((column) => column.sessions));
  const barMax = Math.min(22, Math.max(10, terminalWidth() - 18));

  return (
    <Box flexDirection="column">
      <Box>
        <Tile label="TOTAL SPEND" value={formatUsd(tiles.spendMicroUsd)} color={theme.success} />
        <Tile label="TOTAL TOKENS" value={tiles.totalTokens ? formatTokens(tiles.totalTokens) : "—"} color={theme.accent} />
      </Box>
      <Box>
        <Tile label="SESSIONS" value={String(tiles.sessionCount)} color={theme.accent} />
        <Tile
          label="TOP SPEND MODEL"
          value={tiles.topSpendModel ? truncateModelName(tiles.topSpendModel) : "unpriced"}
          color={theme.warning}
        />
      </Box>
      <Text dimColor>
        {profile.archetype.name} · {snapshot.timeWindow.start.slice(0, 10)} → {snapshot.timeWindow.end.slice(0, 10)}
      </Text>
      <Box height={1}><Text> </Text></Box>
      <Text bold color={theme.accent}>DAILY SPEND</Text>
      {series.columns.length === 0 ? <Text dimColor>No sessions in this window.</Text> : null}
      {series.columns.map((column) => {
        const value = column.unpriced ? column.sessions : column.spendMicroUsd;
        const peak = column.unpriced ? peakSessions : Math.max(peakSpend, 1);
        const filled = barWidth(value, peak, barMax);
        const color = column.unpriced
          ? theme.muted
          : (theme.bar[column.colorIndex % theme.bar.length] ?? theme.accent);
        return (
          <Text key={column.day}>
            <Text dimColor>{column.day.slice(5)} </Text>
            <Text color={color}>{"#".repeat(filled)}</Text>
            {column.unpriced ? <Text dimColor> unpriced</Text> : null}
          </Text>
        );
      })}
      {series.estimated ? (
        <Text dimColor>Daily spend is estimated from session days and each model’s $ / token.</Text>
      ) : null}
      <Box height={1}><Text> </Text></Box>
      {share.rows.map((row) => {
        const color = theme.bar[row.colorIndex % theme.bar.length] ?? theme.accent;
        return (
          <Text key={row.name}>
            <Text color={color}># </Text>
            <Text>{truncateModelName(row.name, 20).padEnd(21)}</Text>
            <Text color={color}>{row.percent.toFixed(1)}%</Text>
          </Text>
        );
      })}
      {share.unpricedTokenPercent !== null ? (
        <Text dimColor># unpriced tokens          {share.unpricedTokenPercent.toFixed(1)}%</Text>
      ) : null}
      <Box height={1}><Text> </Text></Box>
      <Text dimColor>Numbers stay on this machine. Press o for a private copy on buildstory.dev.</Text>
    </Box>
  );
}

export function SessionsView({ snapshot, selected }: { snapshot: ProjectSnapshot; selected: number }) {
  const spark = sessionHourSparkline(snapshot.sessions);
  return (
    <Box flexDirection="column">
      {snapshot.sessions.length > 0 ? (
        <Text dimColor>Hours (UTC) {spark}</Text>
      ) : null}
      {snapshot.sessions.slice(0, 16).map((session, index) => {
        const minutes = Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000));
        const active = index === selected;
        return (
          <Text key={session.sessionRef} inverse={active} color={active ? theme.accent : theme.muted}>
            {active ? "›" : " "} {session.provider.padEnd(14)} {String(minutes).padStart(4)}m  {session.turns} turns  {session.status}
          </Text>
        );
      })}
      {snapshot.sessions.length === 0 ? <Text dimColor>No repository-scoped sessions in this window.</Text> : null}
    </Box>
  );
}

export function SignalsView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const signals = reportSignals(snapshot).slice(0, 10);
  if (!signals.length) return <Text dimColor>No notable signals in this window.</Text>;
  return (
    <Box flexDirection="column">
      {signals.map((signal) => (
        <Box key={signal.id} flexDirection="column" marginBottom={1}>
          <Text bold color={theme.accent}>{signal.headline}</Text>
          <Text dimColor>{signal.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function EvidenceView({ snapshot, mode }: { snapshot: ProjectSnapshot; mode: string }) {
  const excerpts = snapshot.narrativeEvidence?.excerpts.length ?? 0;
  const localNote = mode === "local"
    ? "Local Ollama used redacted excerpts in memory only. They were not written to report.json and were not uploaded."
    : mode === "byok"
      ? "BYOK used redacted excerpts with your provider only. BuildStory never received excerpts or your API key."
      : "No excerpts were selected; this is a metrics-only report.";
  return (
    <Box flexDirection="column">
      <Text color={theme.success}>Source files: not read</Text>
      <Text color={theme.success}>Diffs / commit subjects: not retained</Text>
      <Box height={1}><Text> </Text></Box>
      <Text>Excerpts stored in the report: {excerpts}</Text>
      <Text dimColor>{localNote}</Text>
      <Box height={1}><Text> </Text></Box>
      <Text dimColor>Inspect the engine at github.com/Arjun-Mishra-312/buildstory-scan</Text>
    </Box>
  );
}
