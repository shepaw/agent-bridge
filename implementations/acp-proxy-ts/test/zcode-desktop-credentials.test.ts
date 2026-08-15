import { describe, expect, it } from 'vitest';

import {
  overlayZcodeDesktopCredentials,
  pickZcodeDesktopCredentials,
  providerIdFromSelectedKey,
} from '../src/zcode-desktop-credentials.js';

const cfg = {
  provider: {
    'builtin:bigmodel': {
      enabled: true,
      options: { apiKey: '', baseURL: 'https://open.bigmodel.cn/api/anthropic' },
      models: {
        'GLM-5.3': {
          reasoning: { enabled: true, variants: ['high', 'low', 'max'], defaultVariant: 'max' },
        },
        'GLM-5.2': {},
      },
    },
    'builtin:bigmodel-start-plan': {
      enabled: true,
      options: {
        apiKey: 'plan-jwt',
        baseURL: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic',
      },
      models: { 'GLM-5.3': {}, 'GLM-5-Turbo': {} },
    },
    'builtin:bigmodel-coding-plan': {
      enabled: false,
      options: { apiKey: 'coding-key', baseURL: 'https://open.bigmodel.cn/api/anthropic' },
      models: {
        'GLM-5.3': {
          reasoning: { enabled: true, variants: ['high', 'low', 'max'], defaultVariant: 'max' },
        },
        'GLM-5.2': {},
      },
    },
  },
};

const selectedStartPlan = {
  providerFamilyDomain: 'bigmodel',
  modelProviderFamilySelectedKeys: {
    bigmodel: 'coding-plan:builtin:bigmodel-start-plan',
  },
};

describe('pickZcodeDesktopCredentials', () => {
  it('parses desktop selectedKeys like coding-plan:builtin:…', () => {
    expect(providerIdFromSelectedKey('coding-plan:builtin:bigmodel-start-plan')).toBe(
      'builtin:bigmodel-start-plan',
    );
  });

  it('prefers a non-plan API key over the selected start-plan provider', () => {
    const picked = pickZcodeDesktopCredentials(cfg, selectedStartPlan);
    expect(picked?.providerId).toBe('builtin:bigmodel');
    expect(picked?.ANTHROPIC_API_KEY).toBe('coding-key');
    expect(picked?.planEndpoint).toBe(false);
    expect(picked?.ZCODE_MODEL).toBe('builtin:bigmodel/GLM-5.3');
    expect(picked?.modelVariant).toBe('low');
    expect(picked?.modelCatalog[0]).toMatchObject({
      modelId: 'GLM-5.3',
      reasoning: { enabled: true, defaultLevel: 'low' },
    });
    expect(picked?.ZCODE_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('falls back to start-plan when that is the only keyed provider', () => {
    const picked = pickZcodeDesktopCredentials({
      provider: {
        'builtin:bigmodel': cfg.provider['builtin:bigmodel'],
        'builtin:bigmodel-start-plan': cfg.provider['builtin:bigmodel-start-plan'],
      },
    });
    expect(picked?.providerId).toBe('builtin:bigmodel-start-plan');
    expect(picked?.planEndpoint).toBe(true);
    expect(picked?.ANTHROPIC_API_KEY).toBe('plan-jwt');
  });
});

describe('overlayZcodeDesktopCredentials', () => {
  const creds = pickZcodeDesktopCredentials(cfg, selectedStartPlan);

  it('fills empty Anthropic key from desktop credentials', () => {
    const next = overlayZcodeDesktopCredentials({ ZCODE_BIN: '/tmp/zcode.cjs' }, creds);
    expect(next.ANTHROPIC_API_KEY).toBe('coding-key');
    expect(next.ZCODE_API_KEY).toBe('coding-key');
    expect(next.ZCODE_BASE_URL).toBeUndefined();
  });

  it('does not override an instance-supplied API key', () => {
    const next = overlayZcodeDesktopCredentials(
      { ANTHROPIC_API_KEY: 'explicit-key', ZCODE_MODEL: 'GLM-5.2' },
      creds,
    );
    expect(next.ANTHROPIC_API_KEY).toBe('explicit-key');
    expect(next.ZCODE_MODEL).toBe('GLM-5.2');
  });
});
