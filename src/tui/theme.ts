export const theme = {
  accent: "cyan",
  success: "green",
  warning: "yellow",
  danger: "red",
  muted: "gray",
  bar: ["cyan", "green", "yellow", "magenta", "blue", "white"] as const,
} as const;

export type ThemeColor = (typeof theme)[keyof typeof theme] | (typeof theme.bar)[number];
