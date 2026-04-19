/**
 * Streaming state-machine parser for ACP directive fence syntax.
 *
 * Recognises fenced blocks of the form:
 *
 * ```
 * <<<directive
 * {"type": "action_confirmation", ...}
 * >>>
 * ```
 *
 * Text outside those blocks is emitted as `ACPTextChunk`, and
 * well-formed fenced blocks become `ACPDirective` events.
 *
 * This is a line-for-line port of `shepaw_acp_sdk.directive_parser`
 * with identical state transitions and buffer slicing so the same
 * input reproduces the same event sequence as the Python parser.
 */

import type { ACPDirective, ACPParsedEvent, ACPTextChunk } from './types.js';

enum ParserState {
  StreamingText,
  MaybeDirective,
  InDirective,
}

const OPEN_FENCE = '<<<directive';
const CLOSE_FENCE = '>>>';

export interface ACPDirectiveStreamParserOptions {
  /**
   * When provided, only directives with a `type` in this set are emitted
   * as `ACPDirective`. Unknown types round-trip as text (preserving the
   * fence so downstream consumers can tell).
   */
  knownTypes?: ReadonlySet<string>;
}

export class ACPDirectiveStreamParser {
  private state: ParserState = ParserState.StreamingText;
  private buffer = '';
  private directiveBody = '';
  private fenceLine = '';
  private readonly knownTypes?: ReadonlySet<string>;

  constructor(opts: ACPDirectiveStreamParserOptions = {}) {
    this.knownTypes = opts.knownTypes;
  }

  /** Feed a chunk of streaming text and return any events parsed so far. */
  feed(chunk: string): ACPParsedEvent[] {
    this.buffer += chunk;
    const events: ACPParsedEvent[] = [];
    this.process(events);
    return events;
  }

  /** Flush any buffered content. Call once the upstream stream is done. */
  flush(): ACPParsedEvent[] {
    const events: ACPParsedEvent[] = [];
    if (this.state === ParserState.MaybeDirective) {
      events.push(textChunk(this.fenceLine + this.buffer));
    } else if (this.state === ParserState.InDirective) {
      events.push(textChunk(this.fenceLine + this.directiveBody + this.buffer));
    } else if (this.buffer.length > 0) {
      events.push(textChunk(this.buffer));
    }
    this.buffer = '';
    this.reset();
    return events;
  }

  // ── internal ─────────────────────────────────────────────────

  private reset(): void {
    this.state = ParserState.StreamingText;
    this.directiveBody = '';
    this.fenceLine = '';
  }

  private process(events: ACPParsedEvent[]): void {
    // Run the state machine until no further progress can be made with the
    // current buffer contents (mirrors the `changed = True` loop in Python).
    let changed = true;
    while (changed) {
      changed = false;
      if (this.state === ParserState.StreamingText) {
        changed = this.processStreamingText(events);
      } else if (this.state === ParserState.MaybeDirective) {
        changed = this.processMaybeDirective(events);
      } else if (this.state === ParserState.InDirective) {
        changed = this.processInDirective(events);
      }
    }
  }

  private processStreamingText(events: ACPParsedEvent[]): boolean {
    const idx = this.buffer.indexOf('<<<');
    if (idx === -1) {
      // No `<<<` yet — but a partial `<<` or `<` at the tail might be the
      // start of one on the next chunk, so keep the last 2 chars buffered.
      const safe = this.buffer.length - 2;
      if (safe > 0) {
        events.push(textChunk(this.buffer.slice(0, safe)));
        this.buffer = this.buffer.slice(safe);
      }
      return false;
    }
    if (idx > 0) {
      events.push(textChunk(this.buffer.slice(0, idx)));
    }
    this.buffer = this.buffer.slice(idx);
    this.state = ParserState.MaybeDirective;
    this.fenceLine = '';
    return true;
  }

  private processMaybeDirective(events: ACPParsedEvent[]): boolean {
    const newlineIdx = this.buffer.indexOf('\n');
    if (newlineIdx === -1) return false;
    const firstLine = this.buffer.slice(0, newlineIdx).trim();
    if (firstLine === OPEN_FENCE) {
      this.fenceLine = this.buffer.slice(0, newlineIdx + 1);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.directiveBody = '';
      this.state = ParserState.InDirective;
      return true;
    }
    // Not a directive — flush the leading `<<<` as text and resume.
    events.push(textChunk(this.buffer.slice(0, 3)));
    this.buffer = this.buffer.slice(3);
    this.state = ParserState.StreamingText;
    return true;
  }

  private processInDirective(events: ACPParsedEvent[]): boolean {
    const searchTarget = '\n' + CLOSE_FENCE;
    const closeIdx = this.buffer.indexOf(searchTarget);
    if (closeIdx === -1) {
      // Allow the close fence to appear without a leading newline if the
      // buffer starts with whitespace + `>>>` (matches Python fallback).
      const stripped = this.buffer.trimStart();
      if (stripped.startsWith(CLOSE_FENCE) && this.directiveBody.length > 0) {
        const afterFence = stripped.slice(CLOSE_FENCE.length);
        if (afterFence.length === 0 || afterFence[0] === '\n' || afterFence.trim() === '') {
          const fenceStart = this.buffer.indexOf(CLOSE_FENCE);
          const remaining = this.buffer.slice(fenceStart + CLOSE_FENCE.length);
          return this.tryParseDirective(events, this.directiveBody, remaining);
        }
      }
      // Keep enough of the tail buffered to catch `\n>>>` if it straddles chunks.
      const keep = searchTarget.length - 1;
      const safe = this.buffer.length - keep;
      if (safe > 0) {
        this.directiveBody += this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
      }
      return false;
    }

    const body = this.directiveBody + this.buffer.slice(0, closeIdx);
    let remaining = this.buffer.slice(closeIdx + searchTarget.length);
    const nl = remaining.indexOf('\n');
    remaining = nl !== -1 ? remaining.slice(nl + 1) : '';
    return this.tryParseDirective(events, body, remaining);
  }

  private tryParseDirective(events: ACPParsedEvent[], bodyRaw: string, remaining: string): boolean {
    const body = bodyRaw.trim();
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      const dtype = typeof payload.type === 'string' ? payload.type : undefined;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete payload.type;
      if (dtype !== undefined && (this.knownTypes === undefined || this.knownTypes.has(dtype))) {
        events.push(directiveEvent(dtype, payload));
      } else {
        events.push(textChunk(this.fenceLine + body + '\n' + CLOSE_FENCE));
      }
    } catch {
      events.push(textChunk(this.fenceLine + body + '\n' + CLOSE_FENCE));
    }
    this.buffer = remaining;
    this.reset();
    return true;
  }
}

function textChunk(content: string): ACPTextChunk {
  return { kind: 'text', content };
}

function directiveEvent(directiveType: string, payload: Record<string, unknown>): ACPDirective {
  return { kind: 'directive', directiveType, payload };
}
