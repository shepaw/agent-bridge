"""Streaming state-machine parser for ACP directive fence syntax.

Recognises fenced directive blocks of the form::

    <<<directive
    {"type": "action_confirmation", ...}
    >>>

Everything outside those blocks is emitted as :class:`ACPTextChunk`.
"""

import json
from enum import Enum, auto
from typing import List, Optional, Set, Union

from .types import ACPTextChunk, ACPDirective


class _ACPParserState(Enum):
    STREAMING_TEXT = auto()
    MAYBE_DIRECTIVE = auto()
    IN_DIRECTIVE = auto()


class ACPDirectiveStreamParser:
    """Streaming parser that splits LLM output into text chunks and directives.

    Usage::

        parser = ACPDirectiveStreamParser(known_types={"action_confirmation", "form"})
        async for chunk in llm_stream:
            for event in parser.feed(chunk):
                if isinstance(event, ACPTextChunk):
                    # send text to user
                elif isinstance(event, ACPDirective):
                    # convert to ui.* notification
        for event in parser.flush():
            # handle remaining buffered content
    """

    _OPEN_FENCE = "<<<directive"
    _CLOSE_FENCE = ">>>"

    def __init__(self, known_types: Optional[Set[str]] = None):
        self._state = _ACPParserState.STREAMING_TEXT
        self._buffer = ""
        self._directive_body = ""
        self._fence_line = ""
        self._known_types = known_types

    def feed(self, chunk: str) -> List[Union[ACPTextChunk, ACPDirective]]:
        """Feed a chunk of text and return any events parsed so far."""
        self._buffer += chunk
        events: List[Union[ACPTextChunk, ACPDirective]] = []
        self._process(events)
        return events

    def flush(self) -> List[Union[ACPTextChunk, ACPDirective]]:
        """Call when the LLM stream is done. Flushes any buffered content."""
        events: List[Union[ACPTextChunk, ACPDirective]] = []
        if self._state == _ACPParserState.MAYBE_DIRECTIVE:
            events.append(ACPTextChunk(self._fence_line + self._buffer))
        elif self._state == _ACPParserState.IN_DIRECTIVE:
            events.append(ACPTextChunk(self._fence_line + self._directive_body + self._buffer))
        elif self._buffer:
            events.append(ACPTextChunk(self._buffer))
        self._buffer = ""
        self._reset()
        return events

    def _reset(self):
        self._state = _ACPParserState.STREAMING_TEXT
        self._directive_body = ""
        self._fence_line = ""

    def _process(self, events):
        changed = True
        while changed:
            changed = False
            if self._state == _ACPParserState.STREAMING_TEXT:
                changed = self._process_streaming_text(events)
            elif self._state == _ACPParserState.MAYBE_DIRECTIVE:
                changed = self._process_maybe_directive(events)
            elif self._state == _ACPParserState.IN_DIRECTIVE:
                changed = self._process_in_directive(events)

    def _process_streaming_text(self, events) -> bool:
        idx = self._buffer.find("<<<")
        if idx == -1:
            safe = len(self._buffer) - 2
            if safe > 0:
                events.append(ACPTextChunk(self._buffer[:safe]))
                self._buffer = self._buffer[safe:]
            return False
        if idx > 0:
            events.append(ACPTextChunk(self._buffer[:idx]))
        self._buffer = self._buffer[idx:]
        self._state = _ACPParserState.MAYBE_DIRECTIVE
        self._fence_line = ""
        return True

    def _process_maybe_directive(self, events) -> bool:
        newline_idx = self._buffer.find("\n")
        if newline_idx == -1:
            return False
        first_line = self._buffer[:newline_idx].strip()
        if first_line == self._OPEN_FENCE:
            self._fence_line = self._buffer[:newline_idx + 1]
            self._buffer = self._buffer[newline_idx + 1:]
            self._directive_body = ""
            self._state = _ACPParserState.IN_DIRECTIVE
            return True
        events.append(ACPTextChunk(self._buffer[:3]))
        self._buffer = self._buffer[3:]
        self._state = _ACPParserState.STREAMING_TEXT
        return True

    def _process_in_directive(self, events) -> bool:
        search_target = "\n" + self._CLOSE_FENCE
        close_idx = self._buffer.find(search_target)
        if close_idx == -1:
            if self._buffer.lstrip().startswith(self._CLOSE_FENCE) and self._directive_body:
                stripped = self._buffer.lstrip()
                after_fence = stripped[len(self._CLOSE_FENCE):]
                if not after_fence or after_fence[0] == '\n' or after_fence.strip() == '':
                    return self._try_parse_directive(
                        events,
                        self._directive_body,
                        self._buffer[self._buffer.index(self._CLOSE_FENCE) + len(self._CLOSE_FENCE):],
                    )
            keep = len(search_target) - 1
            safe = len(self._buffer) - keep
            if safe > 0:
                self._directive_body += self._buffer[:safe]
                self._buffer = self._buffer[safe:]
            return False

        body = self._directive_body + self._buffer[:close_idx]
        remaining = self._buffer[close_idx + len(search_target):]
        nl = remaining.find("\n")
        if nl != -1:
            remaining = remaining[nl + 1:]
        else:
            remaining = ""
        return self._try_parse_directive(events, body, remaining)

    def _try_parse_directive(self, events, body: str, remaining: str) -> bool:
        body = body.strip()
        try:
            payload = json.loads(body)
            dtype = payload.pop("type", None)
            if dtype and (self._known_types is None or dtype in self._known_types):
                events.append(ACPDirective(dtype, payload))
            else:
                events.append(ACPTextChunk(self._fence_line + body + "\n" + self._CLOSE_FENCE))
        except (json.JSONDecodeError, ValueError):
            events.append(ACPTextChunk(self._fence_line + body + "\n" + self._CLOSE_FENCE))
        self._buffer = remaining
        self._reset()
        return True
