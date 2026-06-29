import { describe, expect, it } from 'vitest';

import {
  configOptionsToModelsList,
  findModelConfigOption,
  flattenSelectOptions,
  mergeConfigOptions,
} from '../src/config-options.js';
import { supportsSessionLoad, supportsSessionResume } from '../src/session-lifecycle.js';

describe('config-options', () => {
  it('maps model config options to Shepaw models list', () => {
    const result = configOptionsToModelsList([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'claude-opus',
        options: [
          { value: 'claude-opus', name: 'Opus' },
          { value: 'claude-sonnet', name: 'Sonnet' },
        ],
      },
    ]);

    expect(result.models).toHaveLength(2);
    expect(result.current).toBe('claude-opus');
  });

  it('flattens grouped select options', () => {
    const flat = flattenSelectOptions([
      {
        group: 'anthropic',
        name: 'Anthropic',
        options: [{ value: 'a', name: 'A' }],
      },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.value).toBe('a');
  });

  it('merges config option updates by id', () => {
    const merged = mergeConfigOptions(
      [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [] }],
      [{ id: 'thought', name: 'Thought', type: 'select', currentValue: 'low', options: [] }],
    );
    expect(merged).toHaveLength(2);
    expect(findModelConfigOption(merged)?.id).toBe('model');
  });
});

describe('session-lifecycle', () => {
  it('detects resume and load capabilities', () => {
    expect(
      supportsSessionResume({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }),
    ).toBe(true);
    expect(
      supportsSessionLoad({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      }),
    ).toBe(true);
  });
});
