import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ProjectSnapshot } from "../contract.js";
import { uploadProjectSnapshot } from "../local-upload.js";
import { pollPairingUntilGranted, startPairing } from "../pair.js";
import type { ScanProgressEvent, ScanProgressStage } from "../progress.js";
import { generateLocalReport, type GenerateReportRequest, type GenerateReportResult } from "../run-generate.js";
import { Card, Footer, Header, Nav, type DashboardView } from "./chrome.js";
import { studioReportUrl } from "./format.js";
import { openBrowser } from "./open-browser.js";
import { resolvePairApiBase } from "../pair.js";
import { suppressExperimentalSqliteWarning } from "./suppress-warnings.js";
import { theme } from "./theme.js";
import { resolveOpenKey, type OpenPhase } from "./open-keys.js";
import { EvidenceView, ReceiptView, SessionsView, SignalsView, StoryView } from "./views.js";

export type GenerateTuiProps = {
  request: Omit<GenerateReportRequest, "onProgress" | "consent"> & { consent?: "local-scan" };
  requireConsent: boolean;
};

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

export function GenerateApp({ request, requireConsent }: GenerateTuiProps) {
  const { exit } = useApp();
  const [consented, setConsented] = useState(!requireConsent);
  const [events, setEvents] = useState<ScanProgressEvent[]>([]);
  const [result, setResult] = useState<GenerateReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DashboardView>("receipt");
  const [selectedSession, setSelectedSession] = useState(0);
  const [openPhase, setOpenPhase] = useState<OpenPhase>("idle");
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const pairAbort = useRef<AbortController | null>(null);
  const startedAt = useMemo(() => Date.now(), [consented]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    suppressExperimentalSqliteWarning();
  }, []);

  useEffect(() => {
    if (!consented || result || error) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [consented, error, result]);

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

  useEffect(() => () => {
    pairAbort.current?.abort();
  }, []);

  async function runOpenFlow(snapshot: ProjectSnapshot, mode: GenerateReportResult["mode"]) {
    pairAbort.current?.abort();
    const controller = new AbortController();
    pairAbort.current = controller;
    setOpenPhase("waiting");
    setOpenMessage("Opening the browser. Sign in or create an account, then approve this upload.");
    try {
      const started = await startPairing({
        projectLabel: snapshot.repository.displayName,
        narrativeMode: mode,
      });
      setUserCode(started.userCode);
      openBrowser(started.verificationUrl);
      setOpenMessage(`Waiting for approval in the browser · code ${started.userCode}`);
      await pollPairingUntilGranted({
        pairingId: started.pairingId,
        intervalSeconds: started.intervalSeconds,
        expiresAt: started.expiresAt,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setOpenPhase("uploading");
      setOpenMessage("Uploading the report already on disk. Source files are not included.");
      const receipt = await uploadProjectSnapshot(snapshot);
      const origin = resolvePairApiBase().baseUrl.origin;
      const dashboard = studioReportUrl(origin, receipt.reportUrl);
      setOpenPhase("done");
      setOpenMessage(`Uploaded ${receipt.payloadBytes} bytes. Opening the private report.`);
      if (dashboard) openBrowser(dashboard);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setOpenPhase("failed");
      setOpenMessage(cause instanceof Error ? cause.message : "Could not open this report in BuildStory.");
    }
  }

  useInput((input, key) => {
    if (input === "q" || (key.escape && (result || error || openPhase === "failed"))) {
      pairAbort.current?.abort();
      exit();
      return;
    }
    if (!consented) {
      if (input === "y" || input === "Y") setConsented(true);
      if (input === "n" || input === "N") exit();
      return;
    }
    if (openPhase === "confirm" && result) {
      const action = resolveOpenKey(openPhase, input);
      if (action === "start-upload") void runOpenFlow(result.snapshot, result.mode);
      if (action === "cancel") {
        setOpenPhase("idle");
        setOpenMessage(null);
      }
      return;
    }
    if (openPhase === "waiting" || openPhase === "uploading") {
      if (resolveOpenKey(openPhase, input) === "cancel" || key.escape) {
        pairAbort.current?.abort();
        setOpenPhase("idle");
        setOpenMessage("Cancelled. The local report files are still on disk.");
      }
      return;
    }
    if (!result) return;
    if (input === "1") setView("receipt");
    if (input === "2") setView("story");
    if (input === "3") setView("sessions");
    if (input === "4") setView("signals");
    if (input === "5") setView("evidence");
    if (resolveOpenKey(openPhase, input) === "prompt-confirm") {
      setOpenPhase("confirm");
      setOpenMessage(null);
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
        <Card>
          <Text>Generate a local report from AI session metadata and git aggregates?</Text>
        </Card>
        <Text dimColor>
          <Text color={theme.accent}>y</Text> confirm    <Text color={theme.accent}>n</Text> cancel
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Header title="BuildStory" subtitle="Generation stopped" />
        <Card color={theme.danger}>
          <Text color={theme.danger}>{error}</Text>
        </Card>
        <Footer />
      </Box>
    );
  }

  if (!result) {
    const elapsed = `${((now - startedAt) / 1_000).toFixed(1)}s`;
    return (
      <Box flexDirection="column">
        <Card>
          <Text bold color={theme.accent}>BuildStory</Text>
          <Text dimColor>Generating locally · {elapsed}</Text>
          <Box height={1}><Text> </Text></Box>
          {STAGE_ORDER.map((stage) => {
            const event = events.find((item) => item.stage === stage);
            const complete = event?.state === "complete";
            const failed = event?.state === "failed";
            const current = event?.state === "start" || event?.state === "progress";
            const mark = complete ? "✓" : failed ? "✗" : current ? "●" : "·";
            const count = event?.current !== undefined && event.total !== undefined ? ` ${event.current}/${event.total}` : "";
            return (
              <Text
                key={stage}
                dimColor={!event}
                bold={current}
                color={complete ? theme.success : failed ? theme.danger : current ? theme.accent : theme.muted}
              >
                {mark} {STAGE_LABEL[stage]}{count}
                {event?.model ? `  ${event.model}` : ""}
              </Text>
            );
          })}
        </Card>
      </Box>
    );
  }

  const snapshot = result.snapshot;
  const views: Record<DashboardView, React.ReactNode> = {
    story: <StoryView snapshot={snapshot} />,
    receipt: <ReceiptView snapshot={snapshot} />,
    sessions: <SessionsView snapshot={snapshot} selected={selectedSession} />,
    signals: <SignalsView snapshot={snapshot} />,
    evidence: <EvidenceView snapshot={snapshot} mode={result.mode} />,
  };

  if (openPhase === "confirm" || openPhase === "waiting" || openPhase === "uploading") {
    return (
      <Box flexDirection="column">
        <Header title={snapshot.repository.displayName} subtitle={`${result.mode} · wrote ${result.files.directory}`} />
        <Card color={theme.warning}>
          <Text bold>Open this report in BuildStory?</Text>
          <Box height={1}><Text> </Text></Box>
          <Text>This uploads the report already on disk (metrics + story). Source files and diffs stay on this machine.</Text>
          {userCode ? <Text dimColor>Browser code: {userCode}</Text> : null}
          <Box height={1}><Text> </Text></Box>
          <Text color={openPhase === "uploading" ? theme.accent : theme.muted}>{openMessage ?? "Sign in or create an account in the browser, then approve."}</Text>
        </Card>
        <Text dimColor>
          {openPhase === "confirm"
            ? <Text><Text color={theme.accent}>y</Text> upload    <Text color={theme.accent}>n</Text> stay here</Text>
            : <Text><Text color={theme.accent}>n</Text> cancel — files stay on disk</Text>}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header
        title={snapshot.repository.displayName}
        subtitle={`${result.mode} · wrote ${result.files.directory}`}
      />
      <Nav view={view} />
      <Card color={view === "evidence" ? theme.success : theme.accent}>
        {views[view]}
      </Card>
      {openMessage ? <Text color={openPhase === "failed" ? theme.danger : theme.success}>{openMessage}</Text> : null}
      <Footer />
    </Box>
  );
}
