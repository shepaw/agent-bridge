import { useMemo, type CSSProperties } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTypewriter } from '../hooks/useTypewriter.js';
import { chat } from '../utils/chatTheme.js';
import { resolveWorkspaceFileUri } from '../utils/workspaceHref.js';

interface ChatMarkdownProps {
  content: string;
  workspaceUri?: string;
  onOpenStore?: (uri: string) => void;
  /** Smaller typography for progress / thinking blocks. */
  compact?: boolean;
}

interface TypewriterChatMarkdownProps extends ChatMarkdownProps {
  animate: boolean;
  onAnimationComplete?: () => void;
  onProgress?: () => void;
}

export function ChatMarkdown({
  content,
  workspaceUri,
  onOpenStore,
  compact = false,
}: ChatMarkdownProps) {
  const components = useMemo(
    () => buildComponents(workspaceUri, onOpenStore, compact),
    [workspaceUri, onOpenStore, compact],
  );

  if (content.length === 0) return null;

  return (
    <>
      <style>{markdownStyles}</style>
      <div className={`chat-md${compact ? ' chat-md--compact' : ''}`} style={root}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </>
  );
}

export function TypewriterChatMarkdown({
  content,
  animate,
  onAnimationComplete,
  onProgress,
  workspaceUri,
  onOpenStore,
  compact = false,
}: TypewriterChatMarkdownProps) {
  const { displayText, done } = useTypewriter(content, {
    active: animate,
    durationMs: Math.min(4500, Math.max(900, content.length * 14)),
    onComplete: onAnimationComplete,
    onProgress,
  });

  const components = useMemo(
    () => buildComponents(workspaceUri, onOpenStore, compact),
    [workspaceUri, onOpenStore, compact],
  );

  if (content.length === 0) return null;

  return (
    <>
      <style>{markdownStyles}</style>
      <div className={`chat-md${compact ? ' chat-md--compact' : ''}`} style={root}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {displayText}
        </ReactMarkdown>
        {animate && !done && <span style={cursor} aria-hidden>|</span>}
      </div>
    </>
  );
}

function buildComponents(
  workspaceUri: string | undefined,
  onOpenStore: ((uri: string) => void) | undefined,
  compact: boolean,
): Components {
  const linkStyle = compact ? linkCompact : link;
  const codeStyle = compact ? inlineCodeCompact : inlineCode;

  return {
    a: ({ href, children }) => {
      const url = href ?? '';
      const storeUri = resolveWorkspaceFileUri(workspaceUri, url);
      if (storeUri && onOpenStore) {
        return (
          <button
            type="button"
            style={storeLinkBtn}
            onClick={() => onOpenStore(storeUri)}
            title={storeUri}
          >
            {children}
          </button>
        );
      }
      if (/^https?:\/\//i.test(url)) {
        return (
          <a href={url} target="_blank" rel="noreferrer" style={linkStyle}>
            {children}
          </a>
        );
      }
      return <span style={linkStyle}>{children}</span>;
    },
    code: ({ className, children }) => {
      const isBlock = className?.includes('language-');
      if (isBlock) {
        return <code className={className}>{children}</code>;
      }
      return <code style={codeStyle}>{children}</code>;
    },
    pre: ({ children }) => <pre style={pre}>{children}</pre>,
    p: ({ children }) => <p style={compact ? pCompact : p}>{children}</p>,
    ul: ({ children }) => <ul style={compact ? listCompact : list}>{children}</ul>,
    ol: ({ children }) => <ol style={compact ? listCompact : list}>{children}</ol>,
    li: ({ children }) => <li style={compact ? liCompact : li}>{children}</li>,
    blockquote: ({ children }) => <blockquote style={blockquote}>{children}</blockquote>,
    h1: ({ children }) => <h1 style={compact ? hCompact : h1}>{children}</h1>,
    h2: ({ children }) => <h2 style={compact ? hCompact : h2}>{children}</h2>,
    h3: ({ children }) => <h3 style={compact ? hCompact : h3}>{children}</h3>,
    h4: ({ children }) => <h4 style={compact ? hCompact : h4}>{children}</h4>,
    hr: () => <hr style={hr} />,
    table: ({ children }) => (
      <div style={tableWrap}>
        <table style={table}>{children}</table>
      </div>
    ),
    th: ({ children }) => <th style={th}>{children}</th>,
    td: ({ children }) => <td style={td}>{children}</td>,
  };
}

const markdownStyles = `
  .chat-md > :first-child { margin-top: 0; }
  .chat-md > :last-child { margin-bottom: 0; }
  .chat-md pre code {
    background: transparent;
    padding: 0;
    border: none;
    font-size: inherit;
  }
  .chat-md--compact pre { padding: 8px 10px; font-size: 11px; }
`;

const root: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: chat.colors.textPrimary,
  wordBreak: 'break-word',
};

const p: CSSProperties = {
  margin: '0 0 0.75em',
};

const pCompact: CSSProperties = {
  margin: '0 0 0.5em',
  fontSize: 12,
  lineHeight: 1.55,
  color: chat.colors.textSecondary,
};

const list: CSSProperties = {
  margin: '0 0 0.75em',
  paddingLeft: '1.35em',
};

const listCompact: CSSProperties = {
  ...list,
  fontSize: 12,
  color: chat.colors.textSecondary,
};

const li: CSSProperties = {
  margin: '0.25em 0',
};

const liCompact: CSSProperties = {
  margin: '0.2em 0',
};

const h1: CSSProperties = {
  margin: '0 0 0.5em',
  fontSize: 18,
  fontWeight: 700,
  color: chat.colors.textPrimary,
  letterSpacing: '-0.02em',
};

const h2: CSSProperties = {
  margin: '0.8em 0 0.4em',
  fontSize: 16,
  fontWeight: 700,
  color: chat.colors.textPrimary,
};

const h3: CSSProperties = {
  margin: '0.7em 0 0.35em',
  fontSize: 15,
  fontWeight: 600,
  color: chat.colors.textPrimary,
};

const h4: CSSProperties = {
  margin: '0.6em 0 0.3em',
  fontSize: 14,
  fontWeight: 600,
  color: chat.colors.textPrimary,
};

const hCompact: CSSProperties = {
  margin: '0.5em 0 0.25em',
  fontSize: 12,
  fontWeight: 600,
  color: chat.colors.textSecondary,
};

const blockquote: CSSProperties = {
  margin: '0 0 0.75em',
  padding: '6px 12px',
  borderLeft: `3px solid ${chat.colors.accent}`,
  background: chat.colors.bgElevated,
  borderRadius: `0 ${chat.radius.sm}px ${chat.radius.sm}px 0`,
  color: chat.colors.textSecondary,
};

const pre: CSSProperties = {
  margin: '0 0 0.75em',
  padding: '10px 12px',
  background: chat.colors.bgDeep,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: chat.radius.sm,
  overflowX: 'auto',
  fontSize: 12,
  lineHeight: 1.5,
};

const inlineCode: CSSProperties = {
  padding: '2px 5px',
  background: chat.colors.bgElevated,
  border: `1px solid ${chat.colors.border}`,
  borderRadius: 4,
  fontSize: '0.9em',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
};

const inlineCodeCompact: CSSProperties = {
  ...inlineCode,
  fontSize: '0.85em',
};

const link: CSSProperties = {
  color: chat.colors.accent,
  textDecoration: 'underline',
};

const linkCompact: CSSProperties = {
  ...link,
  fontSize: 12,
};

const storeLinkBtn: CSSProperties = {
  display: 'inline',
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'none',
  color: chat.colors.accent,
  cursor: 'pointer',
  font: 'inherit',
  textDecoration: 'underline',
};

const hr: CSSProperties = {
  border: 'none',
  borderTop: `1px solid ${chat.colors.border}`,
  margin: '0.75em 0',
};

const tableWrap: CSSProperties = {
  overflowX: 'auto',
  margin: '0 0 0.75em',
};

const table: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const th: CSSProperties = {
  padding: '6px 10px',
  border: `1px solid ${chat.colors.border}`,
  background: chat.colors.bgElevated,
  textAlign: 'left',
  fontWeight: 600,
};

const td: CSSProperties = {
  padding: '6px 10px',
  border: `1px solid ${chat.colors.border}`,
};

const cursor: CSSProperties = {
  display: 'inline-block',
  marginLeft: 1,
  color: chat.colors.accent,
  animation: 'chatTypeCursor 0.85s step-end infinite',
  fontWeight: 300,
};
