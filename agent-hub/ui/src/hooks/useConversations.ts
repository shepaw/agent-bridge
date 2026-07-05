import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { InstanceStatus, LiveSession, SessionHistoryMessage } from '../api/types.js';

interface UseConversationsOptions {
  instanceId: string;
  status: InstanceStatus | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
}

export function useConversations({
  instanceId,
  status,
  selectedSessionId,
  onSelectSession,
}: UseConversationsOptions) {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const onSelectSessionRef = useRef(onSelectSession);
  onSelectSessionRef.current = onSelectSession;

  const gatewayReady =
    status?.availability === 'online' || status?.availability === 'degraded';

  const loadSessions = useCallback(async (mode: 'initial' | 'background' | 'manual' = 'initial') => {
    if (!gatewayReady) {
      setSessions([]);
      setListError(null);
      setListLoading(false);
      setListRefreshing(false);
      return;
    }

    if (mode === 'initial') {
      setListLoading(true);
    } else if (mode === 'manual') {
      setListRefreshing(true);
    }
    setListError(null);
    try {
      const { sessions: list } = await api.conversations.list(instanceId);
      const sorted = [...list].sort((a, b) => {
        const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
        const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
        return tb - ta;
      });
      setSessions(sorted);
      const activeSessionId = selectedSessionIdRef.current;
      if (
        activeSessionId !== null &&
        !sorted.some((session) => session.session_id === activeSessionId)
      ) {
        onSelectSessionRef.current(null);
      }
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setSessions([]);
    } finally {
      setListLoading(false);
      setListRefreshing(false);
    }
  }, [gatewayReady, instanceId]);

  const loadHistory = useCallback(async (sessionId: string) => {
    setHistoryLoading(true);
    setHistoryError(null);
    setMessages([]);
    try {
      const { messages: transcript } = await api.conversations.history(instanceId, sessionId);
      setMessages(transcript);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
      setMessages([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadSessions('initial');
  }, [loadSessions]);

  useEffect(() => {
    if (!gatewayReady) return;
    const timer = setInterval(() => { void loadSessions('background'); }, 30_000);
    return () => clearInterval(timer);
  }, [gatewayReady, loadSessions]);

  useEffect(() => {
    if (selectedSessionId === null || !gatewayReady) {
      setMessages([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    void loadHistory(selectedSessionId);
  }, [selectedSessionId, gatewayReady, loadHistory]);

  return {
    sessions,
    listLoading,
    listRefreshing,
    listError,
    messages,
    historyLoading,
    historyError,
    gatewayReady,
    loadSessions,
    loadHistory,
  };
}
