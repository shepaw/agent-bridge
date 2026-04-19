import { describe, expect, it } from 'vitest';

import {
  ACPDirectiveStreamParser,
} from '../src/directive-parser.js';
import type { ACPParsedEvent } from '../src/types.js';

function drain(parser: ACPDirectiveStreamParser, chunks: string[]): ACPParsedEvent[] {
  const events: ACPParsedEvent[] = [];
  for (const chunk of chunks) {
    events.push(...parser.feed(chunk));
  }
  events.push(...parser.flush());
  return events;
}

/**
 * Merge consecutive text events. The parser is allowed to fragment text
 * (it holds back a few trailing chars to catch `<<<` across chunk
 * boundaries), but directives must stay intact.
 */
function coalesceText(events: ACPParsedEvent[]): ACPParsedEvent[] {
  const merged: ACPParsedEvent[] = [];
  for (const event of events) {
    const last = merged.at(-1);
    if (event.kind === 'text' && last?.kind === 'text') {
      merged[merged.length - 1] = { kind: 'text', content: last.content + event.content };
    } else {
      merged.push(event);
    }
  }
  return merged;
}

describe('ACPDirectiveStreamParser', () => {
  it('emits plain text as ACPTextChunk', () => {
    const events = coalesceText(drain(new ACPDirectiveStreamParser(), ['hello world']));
    expect(events).toEqual([{ kind: 'text', content: 'hello world' }]);
  });

  it('parses a single directive after text; trailing content on the fence line is consumed', () => {
    // Python SDK behaviour: after `\n>>>`, it searches for the next `\n` in
    // `remaining`; if missing, remaining is dropped. So ` after` (no newline)
    // is swallowed. This is wire-compat with Python `_process_in_directive`.
    const input = 'before <<<directive\n{"type":"form","title":"t"}\n>>> after';
    const events = coalesceText(drain(new ACPDirectiveStreamParser(), [input]));
    expect(events).toEqual([
      { kind: 'text', content: 'before ' },
      { kind: 'directive', directiveType: 'form', payload: { title: 't' } },
    ]);
  });

  it('keeps text that starts on a new line after the closing fence', () => {
    const input = 'before <<<directive\n{"type":"form","title":"t"}\n>>>\n after';
    const events = coalesceText(drain(new ACPDirectiveStreamParser(), [input]));
    expect(events).toEqual([
      { kind: 'text', content: 'before ' },
      { kind: 'directive', directiveType: 'form', payload: { title: 't' } },
      { kind: 'text', content: ' after' },
    ]);
  });

  it('re-emits malformed JSON as text (round-trip preserves fence)', () => {
    // Same behavior: ` post` trailing the `>>>` on the same logical line is dropped.
    // Without coalescing, Python emits the leading text and the fenced body as
    // two separate `text` events.
    const input = 'pre <<<directive\n{not json}\n>>> post';
    const events = drain(new ACPDirectiveStreamParser(), [input]);
    expect(events).toEqual([
      { kind: 'text', content: 'pre ' },
      { kind: 'text', content: '<<<directive\n{not json}\n>>>' },
    ]);
  });

  it('filters unknown types through knownTypes', () => {
    const parser = new ACPDirectiveStreamParser({ knownTypes: new Set(['form']) });
    const events = drain(parser, [
      '<<<directive\n{"type":"unknown","x":1}\n>>>',
    ]);
    expect(events).toEqual([
      { kind: 'text', content: '<<<directive\n{"type":"unknown","x":1}\n>>>' },
    ]);
  });

  it('emits unknown-type output verbatim with fence', () => {
    const parser = new ACPDirectiveStreamParser({ knownTypes: new Set(['form']) });
    const events = drain(parser, [
      '<<<directive\n{"type":"form","ok":true}\n>>>',
    ]);
    expect(events).toEqual([
      { kind: 'directive', directiveType: 'form', payload: { ok: true } },
    ]);
  });

  it('tolerates arbitrary stream splits across chunks', () => {
    // Split every 1-3 characters to stress the state machine.
    // Use `\n>>>\n` + trailing newline so the parser keeps the " omega" tail.
    const full = 'alpha <<<directive\n{"type":"confirm","prompt":"Yes?"}\n>>>\n omega';
    const chunks: string[] = [];
    for (let i = 0; i < full.length; ) {
      const size = (i % 3) + 1;
      chunks.push(full.slice(i, i + size));
      i += size;
    }
    const merged = coalesceText(drain(new ACPDirectiveStreamParser(), chunks));
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ kind: 'text', content: 'alpha ' });
    expect(merged[1]).toEqual({
      kind: 'directive',
      directiveType: 'confirm',
      payload: { prompt: 'Yes?' },
    });
    // Depending on where chunk splits land, the parser may take the fast
    // path (text == " omega") or the fallback path (text == "\n omega"
    // because the fallback branch does not strip the leading newline —
    // matching Python's `_process_in_directive` fallback).
    expect(merged[2]?.kind).toBe('text');
    if (merged[2]?.kind === 'text') {
      expect(merged[2].content.trim()).toBe('omega');
    }
  });

  it('flushes partial directive as text on stream end', () => {
    const parser = new ACPDirectiveStreamParser();
    const events = [
      ...parser.feed('<<<directive\n{"type":"form","title":"t"'),
      ...parser.flush(),
    ];
    // Body never closed → treat the whole thing as text.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'text' });
    if (events[0]?.kind === 'text') {
      expect(events[0].content).toContain('<<<directive');
      expect(events[0].content).toContain('"title":"t"');
    }
  });

  it('handles a false-positive `<<<` not followed by directive', () => {
    const events = drain(new ACPDirectiveStreamParser(), [
      'text with <<<tag and more',
    ]);
    // The `<<<` should not be swallowed — it surfaces as text.
    expect(events.length).toBeGreaterThan(0);
    const joined = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.content)
      .join('');
    expect(joined).toBe('text with <<<tag and more');
  });

  it('supports multiple directives separated by a newline', () => {
    const input =
      '<<<directive\n{"type":"a","n":1}\n>>>\n<<<directive\n{"type":"b","n":2}\n>>>';
    const events = coalesceText(drain(new ACPDirectiveStreamParser(), [input]));
    expect(events).toEqual([
      { kind: 'directive', directiveType: 'a', payload: { n: 1 } },
      { kind: 'directive', directiveType: 'b', payload: { n: 2 } },
    ]);
  });
});
