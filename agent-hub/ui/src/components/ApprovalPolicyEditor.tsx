import type { ApprovalMode, ApprovalPolicy } from '../api/types.js';

export const APPROVAL_KINDS = [
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
] as const;

export function emptyApprovalPolicy(): ApprovalPolicy {
  return { mode: 'ask', allowKinds: [], askKinds: [], allowPatterns: [], denyPatterns: [] };
}

interface ApprovalPolicyEditorProps {
  value: ApprovalPolicy;
  onChange: (v: ApprovalPolicy) => void;
}

/**
 * Reusable editor for a tool-call approval policy. Used in three places:
 * the device-wide default (settings → 全局), per-engine defaults
 * (settings → 引擎), and per-instance overrides (instance detail).
 *
 * The caller owns the `value` state and persistence; this component only
 * renders the controls and reports changes.
 */
export function ApprovalPolicyEditor({ value, onChange }: ApprovalPolicyEditorProps) {
  const toggle = (list: string[], kind: string): string[] =>
    list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind];

  const set = (patch: Partial<ApprovalPolicy>): void =>
    onChange({ ...value, ...patch });

  return (
    <div>
      <label style={labelStyle}>模式</label>
      <select
        style={input}
        value={value.mode}
        onChange={(e) => set({ mode: e.target.value as ApprovalMode })}
      >
        <option value="ask">ask — 全部请求 App 审核（最安全）</option>
        <option value="auto">auto — 全部自动放行（deny/always-ask 除外）</option>
        <option value="custom">custom — 按下方规则放行，其余审核</option>
      </select>

      <label style={labelStyle}>自动放行的工具类型</label>
      <div style={kindGrid}>
        {APPROVAL_KINDS.map((k) => (
          <label key={`allow-${k}`} style={kindChip(value.allowKinds.includes(k))}>
            <input
              type="checkbox"
              style={{ marginRight: 5 }}
              checked={value.allowKinds.includes(k)}
              onChange={() => set({ allowKinds: toggle(value.allowKinds, k) })}
            />
            {k}
          </label>
        ))}
      </div>

      <label style={labelStyle}>始终审核的工具类型（优先级最高）</label>
      <div style={kindGrid}>
        {APPROVAL_KINDS.map((k) => (
          <label key={`ask-${k}`} style={kindChip(value.askKinds.includes(k))}>
            <input
              type="checkbox"
              style={{ marginRight: 5 }}
              checked={value.askKinds.includes(k)}
              onChange={() => set({ askKinds: toggle(value.askKinds, k) })}
            />
            {k}
          </label>
        ))}
      </div>

      <label style={labelStyle}>自动放行正则（每行一条，匹配标题+命令）</label>
      <textarea
        style={{ ...input, minHeight: 56, fontFamily: 'monospace' }}
        value={value.allowPatterns.join('\n')}
        onChange={(e) =>
          set({ allowPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
        }
        placeholder={'^npm (test|run)\n^git status'}
      />
      <label style={labelStyle}>自动拒绝正则（每行一条，优先于放行）</label>
      <textarea
        style={{ ...input, minHeight: 56, fontFamily: 'monospace' }}
        value={value.denyPatterns.join('\n')}
        onChange={(e) =>
          set({ denyPatterns: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
        }
        placeholder={'rm -rf\n:(){ :|:& };:'}
      />
    </div>
  );
}

// ── styles (shared with the rest of the dashboard) ────────────────

function kindChip(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', fontSize: 12,
    padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
    color: active ? '#1e1e2e' : '#cdd6f4',
    background: active ? '#89b4fa' : '#181825',
    border: `1px solid ${active ? '#89b4fa' : '#313244'}`,
  };
}

const labelStyle: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, margin: '10px 0 6px' };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px',
  background: '#181825', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4',
};
const kindGrid: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };
