import { describe, expect, it } from 'vitest';
import { redact } from '@main/logger';

describe('redact', () => {
  it('removes bearer tokens', () => {
    const line = redact('GET /usage Authorization: Bearer sk-ant-oat01-abcdefghijklmnop');
    expect(line).not.toContain('abcdefghijklmnop');
    expect(line).toContain('[redacted]');
  });

  it('removes credential fields from stringified JSON', () => {
    const line = redact('{"accessToken":"secret-value","refresh_token":"another-secret"}');
    expect(line).not.toContain('secret-value');
    expect(line).not.toContain('another-secret');
  });

  it('removes JWTs found anywhere in a message', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(redact(`token=${jwt}`)).not.toContain(jwt);
  });

  it('leaves ordinary diagnostics readable', () => {
    const line = 'could not reach Anthropic: getaddrinfo ENOTFOUND api.anthropic.com';
    expect(redact(line)).toBe(line);
  });
});
