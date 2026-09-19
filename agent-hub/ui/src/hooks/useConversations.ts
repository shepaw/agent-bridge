import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { t } from '../i18n/index.js';
import type {
  ConversationOption,
  InstanceStatus,
  LiveSession,
  SessionHistoryMessage,
} from '../api/types.js';

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
  const [drafts, setDrafts] = useState<LiveSession[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [messages, setMessages] = useState<SessionHistoryMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingReply, setPendingReply] = useState(false);
  const [streamingMessageKey, setStreamingMessageKey] = useState<string | null>(null);

  const [models, setModels] = useState<ConversationOption[]>([]);
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [modes, setModes] = useState<ConversationOption[]>([]);
  const [currentMode, setCurrentMode] = useState<string | undefined>(undefined);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const onSelectSessionRef = useRef(onSelectSession);
  onSelectSessionRef.current = onSelectSession;
  const draftIdsRef = useRef(new Set<string>());
  const skipHistoryLoadRef = useRef(false);

  const gatewayReady =
    status?.availability === 'online' || status?.availability === 'degraded';

  const displayedSessions = useMemo(() => {
    const ids = new Set(sessions.map((s) => s.session_id));
    const extra = drafts.filter((d) => !ids.has(d.session_id));
    return [...extra, ...sessions];
  }, [sessions, drafts]);

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
      const listedIds = new Set(sorted.map((s) => s.session_id));
      setDrafts((prev) => prev.filter((d) => !listedIds.has(d.session_id)));
      for (const id of listedIds) draftIdsRef.current.delete(id);

      const activeSessionId = selectedSessionIdRef.current;
      if (
        activeSessionId !== null &&
        !listedIds.has(activeSessionId) &&
        !draftIdsRef.current.has(activeSessionId)
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
    if (draftIdsRef.current.has(sessionId)) {
      setMessages([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
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

  const startNewSession = useCallback((): string => {
    const sessionId = `hub-dash_${crypto.randomUUID()}`;
    const draft: LiveSession = {
      session_id: sessionId,
      title: t('sessions.draftTitle'),
      updated_at: new Date().toISOString(),
    };
    draftIdsRef.current.add(sessionId);
    skipHistoryLoadRef.current = true;
    setDrafts((prev) => [draft, ...prev.filter((d) => d.session_id !== sessionId)]);
    setMessages([]);
    setHistoryError(null);
    setSendError(null);
    setPendingReply(false);
    setStreamingMessageKey(null);
    onSelectSessionRef.current(sessionId);
    return sessionId;
  }, []);

  const sendChat = useCallback(async (
    raw: string,
    attachments: Array<{ uri: string; name?: string }> = [],
  ) => {
    const message = raw.trim();
    if ((message.length === 0 && attachments.length === 0) || sending) return;

    let sessionId = selectedSessionIdRef.current;
    if (sessionId === null) {
      sessionId = startNewSession();
    }

    const attachmentBlock = attachments.length === 0
      ? ''
      : `\n\nPouch attachments:\n${attachments
        .map((a) => `- [${a.name ?? a.uri}](${a.uri})`)
        .join('\n')}`;
    const userMsg: SessionHistoryMessage = {
      role: 'user',
      content: message.length > 0 ? `${message}${attachmentBlock}` : attachmentBlock.trim(),
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setSending(true);
    setPendingReply(true);
    setSendError(null);
    setHistoryError(null);

    try {
      const result = await api.conversations.chat(instanceId, {
        message,
        session_id: sessionId,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (result.session_id !== sessionId) {
        onSelectSessionRef.current(result.session_id);
      }
      draftIdsRef.current.delete(sessionId);
      draftIdsRef.current.delete(result.session_id);
      setPendingReply(false);
      const streamKey = `stream-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: result.reply,
          message_id: streamKey,
          created_at: new Date().toISOString(),
          ...(result.progress_content !== undefined
            ? {
                progress_content: result.progress_content,
                progress_title: result.progress_title,
                progress_auto_collapse: result.progress_auto_collapse,
              }
            : {}),
        },
      ]);
      setStreamingMessageKey(streamKey);
      void loadSessions('background');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setSendError(t('sessions.chatFailed', { error: err }));
    } finally {
      setSending(false);
      setPendingReply(false);
    }
  }, [instanceId, sending, startNewSession, loadSessions]);

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
      setSendError(null);
      setPendingReply(false);
      setStreamingMessageKey(null);
      return;
    }
    if (skipHistoryLoadRef.current) {
      skipHistoryLoadRef.current = false;
      return;
    }
    void loadHistory(selectedSessionId);
  }, [selectedSessionId, gatewayReady, loadHistory]);

  useEffect(() => {
    if (!gatewayReady) {
      setModels([]);
      setModes([]);
      setCurrentModel(undefined);
      setCurrentMode(undefined);
      setOptionsLoading(false);
      setOptionsError(null);
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    setOptionsError(null);
    const sessionId = selectedSessionId ?? undefined;
    void Promise.all([
      api.conversations.models(instanceId, sessionId),
      api.conversations.modes(instanceId, sessionId),
    ])
      .then(([modelResult, modeResult]) => {
        if (cancelled) return;
        setModels(modelResult.models);
        setCurrentModel(modelResult.current);
        setModes(modeResult.modes);
        setCurrentMode(modeResult.current);
      })
      .catch((e) => {
        if (cancelled) return;
        setModels([]);
        setModes([]);
        setOptionsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gatewayReady, instanceId, selectedSessionId]);

  const setConversationModel = useCallback(async (model: string) => {
    if (optionsBusy || model === currentModel) return;
    const previous = currentModel;
    setCurrentModel(model);
    setOptionsBusy(true);
    setOptionsError(null);
    try {
      const result = await api.conversations.setModel(instanceId, {
        model,
        ...(selectedSessionIdRef.current ? { session_id: selectedSessionIdRef.current } : {}),
      });
      setCurrentModel(result.model);
    } catch (e) {
      setCurrentModel(previous);
      setOptionsError(t('sessions.modelFailed', {
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setOptionsBusy(false);
    }
  }, [currentModel, instanceId, optionsBusy]);

  const setConversationMode = useCallback(async (mode: string) => {
    if (optionsBusy || mode === currentMode) return;
    const previous = currentMode;
    setCurrentMode(mode);
    setOptionsBusy(true);
    setOptionsError(null);
    try {
      const result = await api.conversations.setMode(instanceId, {
        mode,
        ...(selectedSessionIdRef.current ? { session_id: selectedSessionIdRef.current } : {}),
      });
      setCurrentMode(result.mode);
    } catch (e) {
      setCurrentMode(previous);
      setOptionsError(t('sessions.modeFailed', {
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setOptionsBusy(false);
    }
  }, [currentMode, instanceId, optionsBusy]);

  return {
    sessions: displayedSessions,
    listLoading,
    listRefreshing,
    listError,
    messages,
    historyLoading,
    historyError,
    sending,
    sendError,
    pendingReply,
    streamingMessageKey,
    clearStreamingMessage: () => setStreamingMessageKey(null),
    gatewayReady,
    models,
    currentModel,
    modes,
    currentMode,
    optionsLoading,
    optionsBusy,
    optionsError,
    setConversationModel,
    setConversationMode,
    loadSessions,
    loadHistory,
    startNewSession,
    sendChat,
  };
}
