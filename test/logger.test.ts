import { describe, expect, it } from 'vitest';
import { redact } from '@main/logger';

/**
 * These samples are assembled from fragments at runtime rather than written as literals.
 *
 * They have to *look* like credentials for the redaction test to mean anything, but a
 * credential-shaped literal in the source would force an allowlist in the repository secret
 * scan — and an allowlist is exactly where a real secret would eventually hide. Building
 * them here keeps the scan strict with no exceptions while testing the real patterns.
 */
const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'abcdefghijklmnopqrst'].join('-');
const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1'].join(
  '.',
);

describe('redact', () => {
  it('removes bearer tokens', () => {
    const line = redact(`GET /usage Authorization: Bearer ${FAKE_TOKEN}`);
    expect(line).not.toContain(FAKE_TOKEN);
    expect(line).toContain('[redacted]');
  });

  it('removes credential fields from stringified JSON', () => {
    const line = redact('{"accessToken":"secret-value","refresh_token":"another-secret"}');
    expect(line).not.toContain('secret-value');
    expect(line).not.toContain('another-secret');
  });

  it('removes JWTs found anywhere in a message', () => {
    expect(redact(`token=${FAKE_JWT}`)).not.toContain(FAKE_JWT);
  });

  it('removes a bare API key even without a Bearer prefix', () => {
    expect(redact(`key is ${FAKE_TOKEN} here`)).not.toContain(FAKE_TOKEN);
  });

  it('leaves ordinary diagnostics readable', () => {
    const line = 'could not reach Anthropic: getaddrinfo ENOTFOUND api.anthropic.com';
    expect(redact(line)).toBe(line);
  });

  it('does not splice the original input back in when a pattern has no capture groups', () => {
    // The bug this guards: replace() passes (match, offset, whole) for group-less patterns,
    // so trusting the argument positions once put the entire unredacted line into the log.
    const line = redact(`prefix ${FAKE_JWT} suffix`);
    expect(line).toBe('prefix [redacted] suffix');
  });
});
