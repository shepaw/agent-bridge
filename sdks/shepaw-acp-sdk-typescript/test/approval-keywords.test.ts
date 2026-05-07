import { describe, expect, it } from 'vitest';

import { classifyApprovalMessage } from '../src/permissions/approval-keywords.js';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function allow(scope: 'once' | 'pattern') {
  return { verdict: 'allow', scope };
}

function deny(scope: 'once' | 'pattern') {
  return { verdict: 'deny', scope };
}

// ─────────────────────────────────────────────────────────────────────────────
// Basic verdicts
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — basic verdicts', () => {
  it('Allow → allow once', () => {
    expect(classifyApprovalMessage('Allow')).toEqual(allow('once'));
  });

  it('Deny → deny once', () => {
    expect(classifyApprovalMessage('Deny')).toEqual(deny('once'));
  });

  it('empty string → undefined', () => {
    expect(classifyApprovalMessage('')).toBeUndefined();
  });

  it('whitespace only → undefined', () => {
    expect(classifyApprovalMessage('   ')).toBeUndefined();
  });

  it('unrelated message → undefined', () => {
    expect(classifyApprovalMessage('what time is it?')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allow All Similar button (the primary flow)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — Allow All Similar button', () => {
  it('Allow All Similar → allow pattern', () => {
    expect(classifyApprovalMessage('Allow All Similar')).toEqual(allow('pattern'));
  });

  // App sends "Selected action: <label>" for async-confirmation agents
  it('"Selected action: Allow" → allow once (not pattern)', () => {
    expect(classifyApprovalMessage('Selected action: Allow')).toEqual(allow('once'));
  });

  it('"Selected action: Allow All Similar" → allow pattern', () => {
    expect(classifyApprovalMessage('Selected action: Allow All Similar')).toEqual(
      allow('pattern'),
    );
  });

  it('"Selected action: Deny" → deny once', () => {
    expect(classifyApprovalMessage('Selected action: Deny')).toEqual(deny('once'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug regression: "allow" must NOT match ALWAYS_TOKEN "all" as a substring
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — regression: "allow" must not trigger scope=pattern', () => {
  it('"allow" alone → once (not pattern)', () => {
    expect(classifyApprovalMessage('allow')).toEqual(allow('once'));
  });

  it('"Allow" (capitalised) → once', () => {
    expect(classifyApprovalMessage('Allow')).toEqual(allow('once'));
  });

  it('"ALLOW" (upper) → once', () => {
    expect(classifyApprovalMessage('ALLOW')).toEqual(allow('once'));
  });

  it('"allow this" → once', () => {
    expect(classifyApprovalMessage('allow this')).toEqual(allow('once'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug regression: "no" must NOT match inside other words
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — regression: "no" must not substring-match', () => {
  it('"know" → undefined (not deny)', () => {
    expect(classifyApprovalMessage('know')).toBeUndefined();
  });

  it('"another" → undefined (not deny)', () => {
    expect(classifyApprovalMessage('another')).toBeUndefined();
  });

  it('"renew" → undefined (not deny)', () => {
    expect(classifyApprovalMessage('renew')).toBeUndefined();
  });

  it('"no" alone → deny once', () => {
    expect(classifyApprovalMessage('no')).toEqual(deny('once'));
  });

  it('"No" (capitalised) → deny once', () => {
    expect(classifyApprovalMessage('No')).toEqual(deny('once'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scope escalation via ALWAYS_TOKENS
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — scope escalation', () => {
  it('"allow all" → allow pattern', () => {
    expect(classifyApprovalMessage('allow all')).toEqual(allow('pattern'));
  });

  it('"allow always" → allow pattern', () => {
    expect(classifyApprovalMessage('allow always')).toEqual(allow('pattern'));
  });

  it('"allow every time" → allow pattern', () => {
    expect(classifyApprovalMessage('allow every time')).toEqual(allow('pattern'));
  });

  it('"allow similar" → allow pattern', () => {
    expect(classifyApprovalMessage('allow similar')).toEqual(allow('pattern'));
  });

  it('"deny all" → deny pattern', () => {
    expect(classifyApprovalMessage('deny all')).toEqual(deny('pattern'));
  });

  it('"deny all similar" → deny pattern', () => {
    expect(classifyApprovalMessage('deny all similar')).toEqual(deny('pattern'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chinese tokens
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — Chinese tokens', () => {
  it('"同意" → allow once', () => {
    expect(classifyApprovalMessage('同意')).toEqual(allow('once'));
  });

  it('"拒绝" → deny once', () => {
    expect(classifyApprovalMessage('拒绝')).toEqual(deny('once'));
  });

  it('"允许所有" → allow pattern (所有 triggers scope)', () => {
    expect(classifyApprovalMessage('允许所有')).toEqual(allow('pattern'));
  });

  it('"拒绝所有" → deny pattern', () => {
    expect(classifyApprovalMessage('拒绝所有')).toEqual(deny('pattern'));
  });

  it('"同意每次" → allow pattern', () => {
    expect(classifyApprovalMessage('同意每次')).toEqual(allow('pattern'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case insensitivity
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — case insensitivity', () => {
  it('"YES" → allow once', () => {
    expect(classifyApprovalMessage('YES')).toEqual(allow('once'));
  });

  it('"DENY" → deny once', () => {
    expect(classifyApprovalMessage('DENY')).toEqual(deny('once'));
  });

  it('"Allow All Similar" mixed case → allow pattern', () => {
    expect(classifyApprovalMessage('Allow All Similar')).toEqual(allow('pattern'));
  });

  it('"ALLOW ALL SIMILAR" → allow pattern', () => {
    expect(classifyApprovalMessage('ALLOW ALL SIMILAR')).toEqual(allow('pattern'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deny wins over allow when both tokens present
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyApprovalMessage — deny precedence', () => {
  // When both allow and deny tokens appear, deny wins. No ALWAYS_TOKEN present,
  // so scope stays 'once'.
  it('"allow but cancel" → deny once (deny token beats allow token)', () => {
    expect(classifyApprovalMessage('allow but cancel')).toEqual(deny('once'));
  });
});
