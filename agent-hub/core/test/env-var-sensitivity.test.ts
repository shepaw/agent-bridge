import { describe, expect, it } from 'vitest';
import { isSensitiveEnvVarKey } from '../src/env-var-sensitivity.js';

describe('isSensitiveEnvVarKey', () => {
  it('treats key/token/secret names as sensitive', () => {
    expect(isSensitiveEnvVarKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSensitiveEnvVarKey('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(isSensitiveEnvVarKey('OPENAI_API_KEY')).toBe(true);
    expect(isSensitiveEnvVarKey('CURSOR_API_KEY')).toBe(true);
    expect(isSensitiveEnvVarKey('CODEBUDDY_AUTH_TOKEN')).toBe(true);
    expect(isSensitiveEnvVarKey('MY_SECRET')).toBe(true);
    expect(isSensitiveEnvVarKey('DB_PASSWORD')).toBe(true);
  });

  it('treats urls and model ids as non-sensitive', () => {
    expect(isSensitiveEnvVarKey('ANTHROPIC_BASE_URL')).toBe(false);
    expect(isSensitiveEnvVarKey('ANTHROPIC_MODEL')).toBe(false);
    expect(isSensitiveEnvVarKey('OPENAI_BASE_URL')).toBe(false);
    expect(isSensitiveEnvVarKey('CLAUDE_CODE_SUBAGENT_MODEL')).toBe(false);
    expect(isSensitiveEnvVarKey('NO_OPEN_BROWSER')).toBe(false);
  });

  it('defaults empty draft keys to sensitive', () => {
    expect(isSensitiveEnvVarKey('')).toBe(true);
    expect(isSensitiveEnvVarKey('   ')).toBe(true);
  });
});
