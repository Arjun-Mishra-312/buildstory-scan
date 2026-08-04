export type PrivateLocationCategory =
  | "remote-url"
  | "raw-host"
  | "absolute-path"
  | "relative-file-path";

const locationRules: Array<{
  category: PrivateLocationCategory;
  pattern: RegExp;
}> = [
  { category: "remote-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+/i },
  { category: "remote-url", pattern: /\bgit@[^\s:]+:[^\s]+/i },
  { category: "absolute-path", pattern: /(?:^|[\s("'`=])(?:[A-Za-z]:[\\/]|\\\\)[^\s<>()"'`]+/ },
  { category: "absolute-path", pattern: /(?:^|[\s("'`=])\/(?!\/)[^\s<>()"'`]+/ },
  { category: "relative-file-path", pattern: /(?:^|[\s("'`=])(?:\.\.?[\\/]|~[\\/])[^\s<>()"'`]+/ },
  { category: "relative-file-path", pattern: /(?:^|[\s("'`=])(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,11})(?=$|[\s)"'`,;])/ },
  { category: "raw-host", pattern: /\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d{1,5})?\b/i },
  { category: "raw-host", pattern: /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|ai|cloud|tech|local|internal|invalid|test|example)(?::\d{1,5})?\b/i },
];

/** Scans string values only; object keys are validated separately by the schema. */
export function detectPrivateLocations(value: unknown): PrivateLocationCategory[] {
  const findings = new Set<PrivateLocationCategory>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const rule of locationRules) {
        if (rule.pattern.test(candidate)) findings.add(rule.category);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const child of Object.values(candidate)) visit(child);
    }
  };
  visit(value);
  return [...findings].sort();
}
