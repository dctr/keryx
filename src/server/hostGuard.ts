// Host-header allowlist — DNS-rebinding defence for the local Keryx server.
//
// The server binds to localhost and has no built-in authentication, so a
// malicious web page could use DNS rebinding to point a hostname it controls
// at 127.0.0.1 and reach the local API from the victim's browser. Validating
// the Host header against an allowlist blocks that: the browser always sends
// the attacker-controlled hostname, which will not match the loopback names.
//
// Missing-Host policy: a request without a Host header is NOT a browser (HTTP/1.1
// browsers always send one), so the DNS-rebinding attack does not apply. We allow
// it so CLI clients and raw-socket callers keep working. A present-but-malformed
// Host is rejected.

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * Build the set of allowed hostnames (lowercased, port-stripped) from the
 * built-in loopback names plus the optional comma-separated KERYX_ALLOWED_HOSTS
 * escape hatch for reverse-proxy setups.
 */
export function resolveAllowedHosts(env: Record<string, string | undefined>): Set<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTS);

  const extra = env.KERYX_ALLOWED_HOSTS;
  if (typeof extra === 'string') {
    for (const entry of extra.split(',')) {
      const hostname = hostnameFromHeader(entry);
      if (hostname) {
        allowed.add(hostname);
      }
    }
  }

  return allowed;
}

/**
 * Extract the lowercased hostname from a Host header value, stripping an
 * optional port and parsing bracketed IPv6 literals (`[::1]:4173` -> `::1`).
 * Returns null for empty or malformed values.
 */
export function hostnameFromHeader(value: string | undefined | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Bracketed IPv6 literal, e.g. "[::1]" or "[::1]:4173".
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing <= 1) {
      // "[" with no closing bracket, or empty "[]".
      return null;
    }
    const after = trimmed.slice(closing + 1);
    // Anything after "]" must be empty or a ":port".
    if (after.length > 0 && !after.startsWith(':')) {
      return null;
    }
    return trimmed.slice(1, closing).toLowerCase();
  }

  // Unbracketed bare IPv6 literal (more than one colon) — treat whole value as
  // the hostname; we cannot reliably separate a port from the address.
  if (trimmed.indexOf(':') !== trimmed.lastIndexOf(':')) {
    return trimmed.toLowerCase();
  }

  // Hostname or IPv4, with optional ":port".
  const colon = trimmed.indexOf(':');
  const hostname = colon === -1 ? trimmed : trimmed.slice(0, colon);
  if (hostname.length === 0) {
    return null;
  }
  return hostname.toLowerCase();
}

/**
 * Decide whether a Host header value is allowed. A missing/blank Host is
 * allowed (not a browser); a present-but-malformed or non-allowlisted Host is
 * rejected.
 */
export function isHostAllowed(hostHeader: string | undefined | null, allowed: Set<string>): boolean {
  // Missing-Host policy: allow (see module header).
  if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) {
    return true;
  }

  const hostname = hostnameFromHeader(hostHeader);
  if (hostname === null) {
    // Present but malformed — reject.
    return false;
  }

  return allowed.has(hostname);
}
