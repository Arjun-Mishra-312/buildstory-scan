import { isIP } from "node:net";

export function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalized = unwrapped.toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

export function resolveLoopbackHttpUrl(rawValue: string, relativeBase?: URL): URL | null {
  let parsed: URL;
  try {
    parsed = relativeBase ? new URL(rawValue, relativeBase) : new URL(rawValue);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || !isLoopbackHostname(parsed.hostname)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    return null;
  }
  return parsed;
}

export function normalizeLoopbackApiBase(rawValue: string): URL | null {
  const parsed = resolveLoopbackHttpUrl(rawValue);
  if (!parsed) return null;
  const baseUrl = new URL(parsed.href);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
  return baseUrl;
}
