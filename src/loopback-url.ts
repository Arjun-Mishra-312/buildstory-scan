import { isIP } from "node:net";

export function isLoopbackHostname(hostname: string): boolean {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const normalized = unwrapped.toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

/**
 * Loopback is allowed on http or https for local development. A non-loopback
 * host is allowed only on https, and only once the caller has separately
 * pinned it - either by matching an explicit --allow-host (parseConnectEndpoint,
 * the one place a raw --api-base-url string first enters the system) or by
 * an origin-equality check against a value that was already pinned that way
 * (every other call site: the connect response's snapshotEndpoint, and the
 * stored grant/status/report URLs re-read from local state on later runs).
 * This function only validates URL *shape*; it is never itself the pinning
 * check for a fresh, untrusted host.
 */
export function resolveTrustedApiUrl(rawValue: string, relativeBase?: URL): URL | null {
  let parsed: URL;
  try {
    parsed = relativeBase ? new URL(rawValue, relativeBase) : new URL(rawValue);
  } catch {
    return null;
  }
  const loopback = isLoopbackHostname(parsed.hostname);
  if ((!loopback && parsed.protocol !== 'https:')
    || (loopback && !['http:', 'https:'].includes(parsed.protocol))
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    return null;
  }
  return parsed;
}

export function normalizeApiBase(rawValue: string): URL | null {
  const parsed = resolveTrustedApiUrl(rawValue);
  if (!parsed) return null;
  const baseUrl = new URL(parsed.href);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname = `${baseUrl.pathname}/`;
  return baseUrl;
}
