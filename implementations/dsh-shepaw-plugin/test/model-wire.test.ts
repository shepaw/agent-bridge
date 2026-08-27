import { describe, expect, it } from 'vitest';

import {
  decodeModelValue,
  displayNameForModel,
  encodeModelValue,
  resolveCatalogModelValue,
} from '../src/model-wire.js';

describe('model-wire', () => {
  it('round-trips provider/model values', () => {
    expect(encodeModelValue('deepseek-official', 'deepseek-v4-pro')).toBe(
      'deepseek-official/deepseek-v4-pro',
    );
    expect(decodeModelValue('deepseek-official/deepseek-v4-pro')).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    });
  });

  it('rejects malformed wire values', () => {
    expect(decodeModelValue('no-separator')).toBeUndefined();
    expect(decodeModelValue('/model-only')).toBeUndefined();
    expect(decodeModelValue('provider/')).toBeUndefined();
  });

  it('builds display names with optional provider label', () => {
    expect(displayNameForModel('p', 'Model X', 'Provider X')).toBe('Provider X · Model X');
    expect(displayNameForModel('p', 'Model X')).toBe('Model X');
  });

  it('resolves catalog values by full wire id or bare model id', () => {
    const catalog = [
      { value: 'deepseek-official/deepseek-v4-pro', display_name: 'V4 Pro' },
      { value: 'other/other-model', display_name: 'Other' },
    ];
    expect(resolveCatalogModelValue('deepseek-official/deepseek-v4-pro', catalog)).toBe(
      'deepseek-official/deepseek-v4-pro',
    );
    expect(resolveCatalogModelValue('deepseek-v4-pro', catalog)).toBe(
      'deepseek-official/deepseek-v4-pro',
    );
    expect(resolveCatalogModelValue('unknown/model', catalog)).toBeUndefined();
  });
});
