"""Per-session conversation history manager."""

import time
from typing import Dict, List


class ConversationManager:
    """Manages per-session conversation history with automatic trimming.

    Usage::

        conv = ConversationManager(max_history=20)
        conv.add_user_message("session_1", "Hello")
        conv.add_assistant_message("session_1", "Hi there!")
        messages = conv.get_messages("session_1")
    """

    def __init__(self, max_history: int = 20):
        self.max_history = max_history
        self._sessions: Dict[str, List[Dict[str, str]]] = {}
        self._last_access: Dict[str, float] = {}

    def get_messages(self, session_id: str) -> List[Dict[str, str]]:
        """Return the message list for a session (creates empty if needed)."""
        self._last_access[session_id] = time.time()
        return self._sessions.get(session_id, [])

    def add_user_message(self, session_id: str, content: str):
        self._ensure_session(session_id)
        self._sessions[session_id].append({"role": "user", "content": content})
        self._trim(session_id)

    def add_assistant_message(self, session_id: str, content: str):
        self._ensure_session(session_id)
        self._sessions[session_id].append({"role": "assistant", "content": content})
        self._trim(session_id)

    def rollback(self, session_id: str) -> bool:
        """Remove the last assistant+user message pair. Returns True if something was removed."""
        msgs = self._sessions.get(session_id, [])
        if not msgs:
            return False
        if msgs and msgs[-1]["role"] == "assistant":
            msgs.pop()
        if msgs and msgs[-1]["role"] == "user":
            msgs.pop()
        return True

    def has_session(self, session_id: str) -> bool:
        return session_id in self._sessions

    def initialize_session(self, session_id: str, history: List[Dict[str, str]]):
        """Pre-load a session with existing history. Only if session doesn't exist."""
        if session_id in self._sessions:
            return
        self._sessions[session_id] = list(history)
        self._last_access[session_id] = time.time()

    def prepend_history(self, session_id: str, older_messages: List[Dict[str, str]]):
        """Prepend older history messages to the beginning of an existing session."""
        if session_id not in self._sessions:
            return
        self._sessions[session_id] = older_messages + self._sessions[session_id]
        self._last_access[session_id] = time.time()

    def cleanup_expired(self, max_age_seconds: int = 259200):
        """Remove sessions older than max_age_seconds."""
        now = time.time()
        expired = [sid for sid, ts in self._last_access.items()
                   if now - ts > max_age_seconds]
        for sid in expired:
            self._sessions.pop(sid, None)
            self._last_access.pop(sid, None)

    def _ensure_session(self, session_id: str):
        if session_id not in self._sessions:
            self._sessions[session_id] = []
        self._last_access[session_id] = time.time()

    def _trim(self, session_id: str):
        msgs = self._sessions[session_id]
        max_msgs = self.max_history * 2
        if len(msgs) > max_msgs:
            self._sessions[session_id] = msgs[-max_msgs:]
