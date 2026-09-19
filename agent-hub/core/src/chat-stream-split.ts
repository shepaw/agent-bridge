/**
 * Split a dashboard chat stream into the visible answer vs the collapsible
 * progress section (thinking / tool calls / plan).
 *
 * Mirrors the phone client: `ui.messageMetadata.collapsible === true` routes
 * following `ui.textContent` chunks into progress; `collapsible === false`
 * (or no metadata) routes them to the answer.
 */

export interface ChatStreamSection {
  reply: string;
  progressContent?: string;
  progressTitle?: string;
  progressAutoCollapse?: boolean;
}

export function createChatStreamAccumulator(): {
  onMetadata: (meta: Record<string, unknown>) => void;
  onChunk: (content: string) => void;
  result: () => ChatStreamSection;
} {
  let inProgress = false;
  let progressTitle: string | undefined;
  let progressAutoCollapse = true;
  let progress = '';
  let reply = '';

  return {
    onMetadata(meta) {
      const collapsible = meta.collapsible === true;
      inProgress = collapsible;
      if (!collapsible) return;
      const title =
        typeof meta.collapsible_title === 'string' ? meta.collapsible_title.trim() : '';
      if (title.length > 0) progressTitle = title;
      if (typeof meta.auto_collapse === 'boolean') progressAutoCollapse = meta.auto_collapse;
    },
    onChunk(content) {
      if (content.length === 0) return;
      if (inProgress) progress += content;
      else reply += content;
    },
    result() {
      if (progress.length === 0) return { reply };
      return {
        reply,
        progressContent: progress,
        progressTitle: progressTitle ?? 'Thinking',
        progressAutoCollapse,
      };
    },
  };
}
