import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export type DashboardView = "story" | "receipt" | "sessions" | "signals" | "evidence";

export const DASHBOARD_NAV: Array<{ key: string; id: DashboardView; label: string }> = [
  { key: "1", id: "receipt", label: "Receipt" },
  { key: "2", id: "story", label: "Story" },
  { key: "3", id: "sessions", label: "Sessions" },
  { key: "4", id: "signals", label: "Signals" },
  { key: "5", id: "evidence", label: "Evidence" },
];

export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={0} minHeight={2}>
      <Text bold color={theme.accent}>{title}</Text>
      <Text dimColor>{subtitle || " "}</Text>
    </Box>
  );
}

export function Nav({ view }: { view: DashboardView }) {
  return (
    <Box marginBottom={1} paddingX={1}>
      <Text>
        {DASHBOARD_NAV.map((item, index) => {
          const active = item.id === view;
          return (
            <Text key={item.id} color={active ? theme.accent : theme.muted} bold={active} dimColor={!active}>
              {index === 0 ? "" : "  "}
              {active ? `[ ${item.key} ${item.label} ]` : `${item.key} ${item.label}`}
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

export function Card({
  children,
  color = theme.accent,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={2} paddingY={1} marginBottom={1}>
      {children}
    </Box>
  );
}

export function Footer({ hint }: { hint?: string }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text dimColor>────────────────────────────────</Text>
      <Text>
        <Text color={theme.accent}>o</Text>
        <Text dimColor> open in BuildStory     </Text>
        <Text color={theme.accent}>q</Text>
        <Text dimColor> quit</Text>
      </Text>
      {hint ? <Text color={theme.warning}>{hint}</Text> : null}
    </Box>
  );
}
