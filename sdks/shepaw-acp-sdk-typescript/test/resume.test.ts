/**
 * Shared resume constants (src/resume.ts) — the single source of truth for
 * the dashboard's default prompt and the prompt length cap.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_RESUME_PROMPT, RESUME_PROMPT_MAX_LENGTH } from '../src/resume.js';

describe('DEFAULT_RESUME_PROMPT', () => {
  it('is non-empty and stays within the prompt cap', () => {
    expect(DEFAULT_RESUME_PROMPT.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_RESUME_PROMPT.length).toBeLessThanOrEqual(RESUME_PROMPT_MAX_LENGTH);
  });

  it('addresses the coordinating agent and forbids fabrication', () => {
    // The resume exists so a dispatcher can decide what to hand over; the
    // prompt must stay grounded in real workspace facts.
    expect(DEFAULT_RESUME_PROMPT).toContain('协调 agent');
    expect(DEFAULT_RESUME_PROMPT).toContain('不要编造');
    expect(DEFAULT_RESUME_PROMPT).toContain('用户');
  });
});
