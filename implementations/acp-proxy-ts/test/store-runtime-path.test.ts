import { describe, expect, it } from 'vitest';
import {
  buildArtifactRelPath,
  formatStoreMarkdownLink,
  splitChannelId,
} from '../src/store-runtime-path.js';

describe('store-runtime-path', () => {
  it('builds runtime artifact path with owner/channel', () => {
    expect(
      buildArtifactRelPath({
        space: 'runtime',
        filename: 'report.md',
        task: 'general',
        owner: 'agent-x',
        channel: 'ch-x',
      }),
    ).toBe('agent-x/ch-x/artifacts/general/report.md');
  });

  it('splits workflow scoped channel into nested dirs', () => {
    const split = splitChannelId(
      'psess_group_abc__wf_w1__step_s1',
    );
    expect(split.channelId).toBe('psess_group_abc');
    expect(split.workflowScope).toBe('wf_w1__step_s1');
    expect(
      buildArtifactRelPath({
        space: 'runtime',
        filename: 'a.md',
        owner: 'peeragent_x',
        channel: 'psess_group_abc__wf_w1__step_s1',
      }),
    ).toBe(
      'peeragent_x/psess_group_abc/wf_w1__step_s1/artifacts/general/a.md',
    );
  });

  it('keeps legacy artifacts flat path', () => {
    expect(
      buildArtifactRelPath({
        space: 'artifacts',
        filename: 'bridge.md',
        task: 'security',
      }),
    ).toBe('security/bridge.md');
  });

  it('keeps nested sessions filenames without a task prefix', () => {
    expect(
      buildArtifactRelPath({
        space: 'sessions',
        filename: 'claude-code/sess_1.jsonl',
      }),
    ).toBe('claude-code/sess_1.jsonl');
  });

  it('formats markdown share link', () => {
    expect(
      formatStoreMarkdownLink(
        'a.md',
        'store://runtime/aaaaaaaaaaaaaaaa/a/b/artifacts/t/a.md',
      ),
    ).toBe(
      '[a.md](store://runtime/aaaaaaaaaaaaaaaa/a/b/artifacts/t/a.md)',
    );
  });
});
