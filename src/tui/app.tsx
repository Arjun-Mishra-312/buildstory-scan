import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ProjectSnapshot } from "../contract.js";
import { reportSignals, snapshotStoryPack } from "../exporters/report.js";
import { computeBuilderProfile } from "../insights/profile.js";
import type { ScanProgressEvent, ScanProgressStage } from "../progress.js";
import { generateLocalReport, type GenerateReportRequest, type GenerateReportResult } from "../run-generate.js";

export type GenerateTuiProps = {
  request: Omit<GenerateReportRequest, "onProgress" | "consent"> & { consent?: "local-scan" };
  requireConsent: boolean;
};

type View = "story" | "receipt" | "sessions" | "signals" | "evidence";

const STAGE_ORDER: ScanProgressStage[] = [
  "inspect-repository",
  "discovering-providers",
  "parsing-sessions",
  "aggregating-metrics",
  "selecting-evidence",
  "resolving-model",
  "generating-story",
  "generating-insights",
  "validating-story-pack",
];

const STAGE_LABEL: Record<ScanProgressStage, string> = {
  "inspect-repository": "Inspect repository",
  "discovering-providers": "Discover AI session sources",
  "parsing-sessions": "Parse sessions",
  "aggregating-metrics": "Aggregate git and usage",
  "selecting-evidence": "Redact and select evidence",
  "resolving-model": "Resolve model",
  "generating-story": "Generate story",
  "generating-insights": "Generate insights",
  "validating-story-pack": "Write report files",
  uploading: "Upload",
  accepted: "Accepted",
  failed: "Failed",
};

function formatUsd(microUsd: number | null): string {
  if (microUsd === null) return "not priced";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`;
  return String(total);
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" paddingX={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{subtitle}</Text>
    </Box>
  );
}

function Footer({ items }: { items: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{items}</Text>
    </Box>
  );
}

function StoryView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const pack = snapshotStoryPack(snapshot);
  const width = Math.max(40, (process.stdout.columns ?? 80) - 4);
  if (!pack) {
    return <Text dimColor>Metrics-only report. No narrative was generated.</Text>;
  }
  return (
    <Box flexDirection="column">
      <Text bold>{pack.hero.headline}</Text>
      {wrap(pack.hero.summary, width).map((line, index) => <Text key={`s-${index}`}>{line}</Text>)}
      <Text> </Text>
      {pack.buildArc.map((phase) => (
        <Box key={phase.phase} flexDirection="column" marginBottom={1}>
          <Text>
            <Text dimColor>{phase.phase.toUpperCase()}</Text>
            <Text>  {phase.headline}</Text>
          </Text>
          {wrap(phase.summary, width).map((line, index) => <Text key={`${phase.phase}-${index}`} dimColor>{line}</Text>)}
        </Box>
      ))}
      <Text bold>Turning point</Text>
      {wrap(pack.turningPoint.quote, width).map((line, index) => <Text key={`tp-${index}`}>{line}</Text>)}
    </Box>
  );
}

function ReceiptView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const profile = computeBuilderProfile({
    sessions: snapshot.sessions,
    usage: snapshot.usage,
    git: snapshot.git,
    timeWindow: snapshot.timeWindow,
  });
  const tokens = snapshot.usage.tokenUsage?.totalTokens ?? 0;
  const models = snapshot.usage.models.slice(0, 6);
  const maxTurns = Math.max(1, ...models.map((model) => model.turnCount));
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{String(snapshot.sessions.length).padStart(4)}</Text>
        <Text dimColor>  sessions</Text>
        <Text>   </Text>
        <Text bold>{String(snapshot.git.commits).padStart(4)}</Text>
        <Text dimColor>  commits</Text>
        <Text>   </Text>
        <Text bold>{formatTokens(tokens).padStart(6)}</Text>
        <Text dimColor>  tokens</Text>
        <Text>   </Text>
        <Text bold>{formatUsd(snapshot.usage.cost.totalMicroUsd)}</Text>
      </Text>
      <Text dimColor>
        {profile.archetype.name} · {snapshot.timeWindow.start.slice(0, 10)} → {snapshot.timeWindow.end.slice(0, 10)}
      </Text>
      <Text> </Text>
      {models.map((model) => {
        const width = Math.max(1, Math.round((model.turnCount / maxTurns) * 16));
        return (
          <Text key={model.name}>
            <Text>{model.name.padEnd(22).slice(0, 22)}</Text>
            <Text> </Text>
            <Text>{"█".repeat(width)}</Text>
            <Text dimColor> {model.turnCount}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function SessionsView({ snapshot, selected }: { snapshot: ProjectSnapshot; selected: number }) {
  return (
    <Box flexDirection="column">
      {snapshot.sessions.slice(0, 16).map((session, index) => {
        const minutes = Math.max(0, Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000));
        const marker = index === selected ? "›" : " ";
        return (
          <Text key={session.sessionRef} inverse={index === selected}>
            {marker} {session.provider.padEnd(14)} {String(minutes).padStart(4)}m  {session.turns} turns  {session.status}
          </Text>
        );
      })}
      {snapshot.sessions.length === 0 ? <Text dimColor>No repository-scoped sessions in this window.</Text> : null}
    </Box>
  );
}

function SignalsView({ snapshot }: { snapshot: ProjectSnapshot }) {
  const signals = reportSignals(snapshot).slice(0, 10);
  if (!signals.length) return <Text dimColor>No notable signals in this window.</Text>;
  return (
    <Box flexDirection="column">
      {signals.map((signal) => (
        <Box key={signal.id} flexDirection="column" marginBottom={1}>
          <Text bold>{signal.headline}</Text>
          <Text dimColor>{signal.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

function EvidenceView({ snapshot, mode }: { snapshot: ProjectSnapshot; mode: string }) {
  const excerpts = snapshot.narrativeEvidence?.excerpts.length ?? 0;
  const destination = mode === "local"
    ? "loopback Ollama only — nothing left this machine except the optional later upload you choose"
    : mode === "byok"
      ? "your configured provider only — Buildstory never received excerpts or your API key"
      : "no excerpts were selected; metrics only";
  return (
    <Box flexDirection="column">
      <Text>Source files: not read</Text>
      <Text>Diffs / commit subjects: not retained</Text>
      <Text>Excerpts selected: {excerpts}</Text>
      <Text>Destination: {destination}</Text>
      <Text> </Text>
      <Text dimColor>Inspect the engine at github.com/Arjun-Mishra-312/buildstory-scan</Text>
    </Box>
  );
}

export function GenerateApp({ request, requireConsent }: GenerateTuiProps) {
  const { exit } = useApp();
  const [consented, setConsented] = useState(!requireConsent);
  const [events, setEvents] = useState<ScanProgressEvent[]>([]);
  const [result, setResult] = useState<GenerateReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("story");
  const [selectedSession, setSelectedSession] = useState(0);
  const startedAt = useMemo(() => Date.now(), [consented]);

  useEffect(() => {
    if (!consented || result || error) return;
    let cancelled = false;
    void (async () => {
      try {
        const generated = await generateLocalReport({
          ...request,
          consent: "local-scan",
          onProgress: (event) => {
            if (!cancelled) setEvents((current) => [...current.filter((item) => item.stage !== event.stage), event]);
          },
        });
        if (!cancelled) setResult(generated);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "generate failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [consented, error, request, result]);

  useInput((input, key) => {
    if (input === "q" || (key.escape && (result || error))) {
      exit();
      return;
    }
    if (!consented) {
      if (input === "y" || input === "Y") setConsented(true);
      if (input === "n" || input === "N") exit();
      return;
    }
    if (!result) return;
    if (input === "1") setView("story");
    if (input === "2") setView("receipt");
    if (input === "3") setView("sessions");
    if (input === "4") setView("signals");
    if (input === "5") setView("evidence");
    if (input === "o") {
      process.stderr.write("https://buildstory.dev\n");
    }
    if (view === "sessions") {
      if (key.downArrow) setSelectedSession((value) => Math.min(value + 1, Math.max(0, result.snapshot.sessions.length - 1)));
      if (key.upArrow) setSelectedSession((value) => Math.max(0, value - 1));
    }
  });

  if (!consented) {
    return (
      <Box flexDirection="column">
        <Header title="BuildStory" subtitle="Read-only scan of this Git worktree. Source files and diffs are not read." />
        <Text>Generate a local report from AI session metadata and git aggregates?</Text>
        <Footer items="y confirm   n cancel" />
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Header title="BuildStory" subtitle="Generation stopped" />
        <Text color="red">{error}</Text>
        <Footer items="q quit" />
      </Box>
    );
  }

  if (!result) {
    const elapsed = `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`;
    return (
      <Box flexDirection="column">
        <Header title="BuildStory" subtitle={`Generating locally · ${elapsed}`} />
        {STAGE_ORDER.map((stage) => {
          const event = events.find((item) => item.stage === stage);
          const mark = event?.state === "complete" ? "✓" : event?.state === "failed" ? "✗" : event ? "●" : "·";
          const count = event?.current !== undefined && event.total !== undefined ? ` ${event.current}/${event.total}` : "";
          return (
            <Text key={stage} dimColor={!event} bold={event?.state === "start" || event?.state === "progress"}>
              {mark} {STAGE_LABEL[stage]}{count}
              {event?.model ? `  ${event.model}` : ""}
            </Text>
          );
        })}
      </Box>
    );
  }

  const snapshot = result.snapshot;
  const views: Record<View, React.ReactNode> = {
    story: <StoryView snapshot={snapshot} />,
    receipt: <ReceiptView snapshot={snapshot} />,
    sessions: <SessionsView snapshot={snapshot} selected={selectedSession} />,
    signals: <SignalsView snapshot={snapshot} />,
    evidence: <EvidenceView snapshot={snapshot} mode={result.mode} />,
  };
  return (
    <Box flexDirection="column">
      <Header
        title={snapshot.repository.displayName}
        subtitle={`${result.mode} · wrote ${result.files.directory}`}
      />
      {views[view]}
      <Footer items="1 story  2 receipt  3 sessions  4 signals  5 evidence  o open BuildStory  q quit" />
    </Box>
  );
}
