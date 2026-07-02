import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { ApprovalPolicy, Instance } from '../api/types.js';
import { ApprovalPolicyEditor, emptyApprovalPolicy } from './ApprovalPolicyEditor.js';

interface InstanceApprovalSectionProps {
  instance: Instance;
  onChanged: () => void;
}

/**
 * Per-instance tool-call approval override. When set, it fully replaces the
 * engine default and the device-wide default for this instance only. Cleared
 * → the instance inherits (engine → global → always-ask).
 */
export function InstanceApprovalSection({ instance, onChanged }: InstanceApprovalSectionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ApprovalPolicy>(instance.approval ?? emptyApprovalPolicy());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(instance.approval ?? emptyApprovalPolicy());
  }, [instance.approval]);

  const save = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.instances.setApproval(instance.id, draft);
      setNotice('已保存。重启 Agent 后生效。');
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.instances.clearApproval(instance.id);
      setDraft(emptyApprovalPolicy());
      setNotice('已清除实例覆盖——回退到引擎/全局默认。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasOverride = instance.approval != null;

  return (
    <>
      <h4 style={sectionTitle}>工具调用审核策略</h4>
      <div style={card}>
        <div style={rowHead}>
          <div>
            <span style={badge(hasOverride)}>
              {hasOverride ? `实例覆盖（${instance.approval!.mode}）` : '继承引擎 / 全局默认'}
            </span>
            <p style={hint}>
              优先级：实例覆盖 {'>'} 引擎默认 {'>'} 全局默认 {'>'} always-ask。
              {!hasOverride && ' 当前未设置实例覆盖。'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {!editing && (
              <button style={smallBtn} onClick={() => { setDraft(instance.approval ?? emptyApprovalPolicy()); setEditing(true); }}>
                {hasOverride ? '编辑覆盖' : '设置覆盖'}
              </button>
            )}
            {hasOverride && !editing && (
              <button style={dangerBtn} disabled={busy} onClick={() => void clear()}>清除（继承）</button>
            )}
          </div>
        </div>

        {editing && (
          <div style={{ marginTop: 12, borderTop: '1px solid #313244', paddingTop: 12 }}>
            <ApprovalPolicyEditor value={draft} onChange={setDraft} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button style={primaryBtn} disabled={busy} onClick={() => void save()}>保存</button>
              <button style={secondaryBtn} disabled={busy} onClick={() => setEditing(false)}>取消</button>
            </div>
          </div>
        )}

        {notice && <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 8 }}>{notice}</p>}
        {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 8 }}>{err}</p>}
      </div>
    </>
  );
}

const sectionTitle: React.CSSProperties = { margin: '24px 0 8px', color: '#cdd6f4', fontSize: 14 };
const card: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 8, padding: 14,
};
const rowHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '6px 0 0' };
const badge = (active: boolean): React.CSSProperties => ({
  fontSize: 12, padding: '3px 8px', borderRadius: 6, display: 'inline-block',
  color: active ? '#1e1e2e' : '#cdd6f4',
  background: active ? '#89b4fa' : '#313244',
});
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
};
const smallBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12,
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8',
  borderRadius: 5, padding: '6px 12px', cursor: 'pointer', fontSize: 12,
};
