import { describe, expect, it } from 'vitest';

import { hostnameFromHeader, isHostAllowed, resolveAllowedHosts } from '../../src/server/hostGuard';

describe('resolveAllowedHosts', () => {
  it('always allows the loopback names regardless of env', () => {
    const allowed = resolveAllowedHosts({});
    expect(allowed.has('localhost')).toBe(true);
    expect(allowed.has('127.0.0.1')).toBe(true);
    expect(allowed.has('::1')).toBe(true);
  });

  it('extends the allowlist from a comma-separated KERYX_ALLOWED_HOSTS, normalising ports and brackets', () => {
    const allowed = resolveAllowedHosts({ KERYX_ALLOWED_HOSTS: 'Keryx.Example.com:4173 , [fe80::1] , 10.0.0.5' });
    expect(allowed.has('keryx.example.com')).toBe(true);
    expect(allowed.has('fe80::1')).toBe(true);
    expect(allowed.has('10.0.0.5')).toBe(true);
    // loopback defaults are still present.
    expect(allowed.has('localhost')).toBe(true);
  });

  it('ignores blank entries in KERYX_ALLOWED_HOSTS', () => {
    const allowed = resolveAllowedHosts({ KERYX_ALLOWED_HOSTS: ' , ,proxy.internal, ' });
    expect(allowed.has('proxy.internal')).toBe(true);
    expect(allowed.has('')).toBe(false);
  });
});

describe('hostnameFromHeader', () => {
  it('parses hostnames with and without ports', () => {
    expect(hostnameFromHeader('localhost')).toBe('localhost');
    expect(hostnameFromHeader('localhost:4173')).toBe('localhost');
    expect(hostnameFromHeader('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameFromHeader('127.0.0.1:4173')).toBe('127.0.0.1');
  });

  it('parses bracketed IPv6 literals, stripping brackets and the optional port', () => {
    expect(hostnameFromHeader('[::1]')).toBe('::1');
    expect(hostnameFromHeader('[::1]:4173')).toBe('::1');
    expect(hostnameFromHeader('[FE80::1]:8080')).toBe('fe80::1');
  });

  it('treats an unbracketed bare IPv6 literal as the whole hostname', () => {
    expect(hostnameFromHeader('::1')).toBe('::1');
  });

  it('lowercases hostnames for case-insensitive comparison', () => {
    expect(hostnameFromHeader('LocalHost:4173')).toBe('localhost');
  });

  it('returns null for empty or malformed hosts', () => {
    expect(hostnameFromHeader('')).toBeNull();
    expect(hostnameFromHeader('   ')).toBeNull();
    expect(hostnameFromHeader('[::1')).toBeNull();
    expect(hostnameFromHeader('[]')).toBeNull();
  });
});

describe('isHostAllowed', () => {
  const allowed = resolveAllowedHosts({});

  it('allows the loopback hostnames with or without a port', () => {
    expect(isHostAllowed('localhost', allowed)).toBe(true);
    expect(isHostAllowed('localhost:4173', allowed)).toBe(true);
    expect(isHostAllowed('127.0.0.1', allowed)).toBe(true);
    expect(isHostAllowed('127.0.0.1:4173', allowed)).toBe(true);
    expect(isHostAllowed('[::1]', allowed)).toBe(true);
    expect(isHostAllowed('[::1]:4173', allowed)).toBe(true);
  });

  it('rejects non-local hosts (DNS-rebinding defence)', () => {
    expect(isHostAllowed('evil.example.com', allowed)).toBe(false);
    expect(isHostAllowed('attacker.test:4173', allowed)).toBe(false);
    expect(isHostAllowed('192.168.1.10', allowed)).toBe(false);
  });

  it('allows a missing Host header: a client without one is not a browser, so DNS rebinding does not apply', () => {
    // Documented missing-Host policy — CLI clients (curl --no-host, raw sockets)
    // do not send Host and are not subject to the browser DNS-rebinding attack.
    expect(isHostAllowed(undefined, allowed)).toBe(true);
    expect(isHostAllowed('', allowed)).toBe(true);
    expect(isHostAllowed('   ', allowed)).toBe(true);
  });

  it('rejects a present-but-malformed Host header', () => {
    expect(isHostAllowed('[::1', allowed)).toBe(false);
  });

  it('honours an extended allowlist for reverse-proxy hostnames', () => {
    const extended = resolveAllowedHosts({ KERYX_ALLOWED_HOSTS: 'keryx.example.com' });
    expect(isHostAllowed('keryx.example.com', extended)).toBe(true);
    expect(isHostAllowed('keryx.example.com:443', extended)).toBe(true);
    expect(isHostAllowed('other.example.com', extended)).toBe(false);
  });
});
