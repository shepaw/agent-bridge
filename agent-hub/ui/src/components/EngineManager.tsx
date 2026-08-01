import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type {
  ApprovalPolicy,
  EngineEnvVarHint,
  EngineInfo,
  EngineInstallStatus,
  EngineSetupGuide,
  MaskedEnvVar,
} from '../api/types.js';
import { ApprovalPolicyEditor, emptyApprovalPolicy } from './ApprovalPolicyEditor.js';
import { isSensitiveEnvVarKey } from '../utils/envVarSensitivity.js';

type EnvDraft = { key: string; value: string };

function emptyEnvDraft(): EnvDraft {
  return { key: '', value: '' };
}

/**
 * Engine management: list every engine (built-in + custom) and configure
 * per-engine overrides — enable/disable, display name + ACP command (custom
 * only), default credentials, and a default tool-call approval policy.
 */
export function EngineManager({
  focusEngineId = null,
  onFocusEngineHandled,
}: {
  focusEngineId?: string | null;
  onFocusEngineHandled?: () => void;
}) {
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Add-custom-engine form state
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCmd, setNewCmd] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const { engines: list } = await api.engines.list();
      setEngines(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addEngine = async () => {
    setAdding(true); setErr(null);
    try {
      if (!newId.trim() || !newName.trim() || !newCmd.trim()) {
        throw new Error('ID、显示名、ACP 命令均为必填。');
      }
      await api.engines.create({ id: newId.trim(), displayName: newName.trim(), acpCommand: newCmd.trim() });
      setNewId(''); setNewName(''); setNewCmd('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <div style={addBlock}>
        <h4 style={sectionTitle}>添加自定义引擎</h4>
        <div style={addRow}>
          <input style={input} placeholder="引擎 ID（如 my-cli）" value={newId} onChange={(e) => setNewId(e.target.value)} />
          <input style={input} placeholder="显示名" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <input style={{ ...input, flex: 2 }} placeholder="ACP 命令（如 /usr/local/bin/my-cli --acp）" value={newCmd} onChange={(e) => setNewCmd(e.target.value)} />
          <button style={primaryBtn} disabled={adding} onClick={() => void addEngine()}>
            {adding ? '添加中…' : '添加'}
          </button>
        </div>
      </div>

      <h4 style={{ ...sectionTitle, marginTop: 20 }}>引擎列表（{engines.length}）</h4>
      <p style={hint}>
        每个引擎可单独设置默认环境变量与审核策略。审核策略优先级：实例覆盖 {'>'} 引擎默认 {'>'} 全局默认。环境变量支持任意自定义键值。
      </p>

      <div style={listCol}>
        {engines.map((eng) => (
          <EngineRow
            key={eng.id}
            engine={eng}
            onChanged={load}
            initialOpen={eng.id === focusEngineId}
            highlight={eng.id === focusEngineId}
            onOpened={eng.id === focusEngineId ? onFocusEngineHandled : undefined}
          />
        ))}
      </div>

      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function EngineRow({
  engine,
  onChanged,
  initialOpen = false,
  highlight = false,
  onOpened,
}: {
  engine: EngineInfo;
  onChanged: () => void;
  initialOpen?: boolean;
  highlight?: boolean;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const rowRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Edit fields (custom only)
  const [displayName, setDisplayName] = useState(engine.displayName);
  const [acpCommand, setAcpCommand] = useState(engine.acpCommand);

  // Approval
  const [approval, setApproval] = useState<ApprovalPolicy>(engine.approval ?? emptyApprovalPolicy());

  // Env vars
  const [envVars, setEnvVars] = useState<MaskedEnvVar[]>([]);
  const [envDrafts, setEnvDrafts] = useState<EnvDraft[]>([emptyEnvDraft()]);
  const [envHints, setEnvHints] = useState<EngineEnvVarHint[]>([]);
  const [envEditing, setEnvEditing] = useState<Record<string, string>>({});

  useEffect(() => {
    setDisplayName(engine.displayName);
    setAcpCommand(engine.acpCommand);
    setApproval(engine.approval ?? emptyApprovalPolicy());
  }, [engine]);

  useEffect(() => {
    if (initialOpen) {
      setOpen(true);
      void loadEnv();
    }
  }, [initialOpen]);

  useEffect(() => {
    if (highlight && open && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      onOpened?.();
    }
  }, [highlight, open, onOpened]);

  const loadEnv = async () => {
    try {
      setEnvVars(await api.engines.envvars.list(engine.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const openConfig = () => {
    const next = !open;
    setOpen(next);
    if (next) void loadEnv();
  };

  const toggleDisabled = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.setOverride(engine.id, { disabled: !engine.disabled });
      setNotice(engine.disabled ? '已启用。' : '已禁用——新建实例将不可选此引擎。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.update(engine.id, { displayName, acpCommand });
      setNotice('已保存引擎设置。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveApproval = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.setOverride(engine.id, { approval });
      setNotice('已保存引擎审核策略。使用该引擎的实例重启后生效（除非实例自行覆盖）。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearApproval = async () => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.clearApproval(engine.id);
      setApproval(emptyApprovalPolicy());
      setNotice('已清除引擎审核策略（回退到全局默认）。');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEnvDrafts = async () => {
    const rows = envDrafts
      .map((r) => ({ key: r.key.trim(), value: r.value }))
      .filter((r) => r.key.length > 0);
    if (rows.length === 0) {
      setErr('请至少填写一个变量名。');
      return;
    }
    const keys = rows.map((r) => r.key);
    if (new Set(keys).size !== keys.length) {
      setErr('草稿中存在重复的变量名。');
      return;
    }
    setBusy(true); setErr(null); setNotice(null);
    try {
      for (const row of rows) {
        await api.engines.envvars.set(engine.id, row.key, row.value);
      }
      setEnvDrafts([emptyEnvDraft()]);
      setNotice(`已保存 ${rows.length} 个环境变量。`);
      await loadEnv();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateExistingEnv = async (key: string) => {
    const value = envEditing[key];
    if (value === undefined) return;
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.envvars.set(engine.id, key, value);
      setEnvEditing((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setNotice(`已更新 ${key}。`);
      await loadEnv();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeEnv = async (key: string) => {
    setBusy(true); setErr(null); setNotice(null);
    try {
      await api.engines.envvars.remove(engine.id, key);
      await loadEnv();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applySuggestedKey = (key: string) => {
    setEnvDrafts((prev) => {
      if (prev.some((r) => r.key.trim() === key)) return prev;
      const blankIdx = prev.findIndex((r) => r.key.trim() === '');
      if (blankIdx >= 0) {
        return prev.map((r, i) => (i === blankIdx ? { ...r, key } : r));
      }
      return [...prev, { key, value: '' }];
    });
  };

  const existingKeys = new Set(envVars.map((v) => v.key));
  const missingHints = envHints.filter((h) => !existingKeys.has(h.key));

  const removeEngine = async () => {
    if (!confirm(`删除自定义引擎 "${engine.displayName}"？使用该引擎的实例需先改换引擎。`)) return;
    setBusy(true); setErr(null);
    try {
      await api.engines.remove(engine.id);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rowRef} style={{ ...row, ...(highlight ? rowHighlight : {}) }}>
      <div style={rowHead}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ color: engine.disabled ? '#6c7086' : '#cdd6f4' }}>{engine.displayName}</strong>
          <code style={tag}>{engine.id}</code>
          <span style={{ ...tag, background: engine.builtin ? '#3a4a2a' : '#313244', color: engine.builtin ? '#a6e3a1' : '#cdd6f4' }}>
            {engine.builtin ? '内置' : '自定义'}
          </span>
          {engine.available === true && (
            <span style={{ ...tag, background: '#3a4a2a', color: '#a6e3a1' }}>可用</span>
          )}
          {engine.available === false && (
            <span style={{ ...tag, background: '#452632', color: '#f38ba8' }} title={engine.unavailableReason ?? undefined}>
              不可用
            </span>
          )}
          {engine.disabled && <span style={{ ...tag, background: '#452632', color: '#f38ba8' }}>已禁用</span>}
          {engine.approval && <span style={{ ...tag, background: '#2a3a4a', color: '#89dceb' }}>审核: {engine.approval.mode}</span>}
          {engine.envVarKeys && engine.envVarKeys.length > 0 && (
            <span style={tag}>{engine.envVarKeys.length} 个凭据</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={smallBtn} disabled={busy} onClick={() => void toggleDisabled()}>
            {engine.disabled ? '启用' : '禁用'}
          </button>
          <button style={smallBtn} onClick={openConfig}>
            {open ? '收起' : '配置'}
          </button>
        </div>
      </div>

      {open && (
        <div style={rowBody}>
          <EngineSetupSection
            engine={engine}
            onChanged={onChanged}
            onError={setErr}
            onNotice={setNotice}
            onEnvHints={setEnvHints}
          />

          {!engine.builtin && (
            <div style={subSection}>
              <h5 style={subTitle}>引擎命令（自定义）</h5>
              <label style={labelStyle}>显示名</label>
              <input style={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <label style={labelStyle}>ACP 命令</label>
              <input style={input} value={acpCommand} onChange={(e) => setAcpCommand(e.target.value)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button style={primaryBtn} disabled={busy} onClick={() => void saveEdit()}>保存</button>
                <button style={dangerBtn} disabled={busy} onClick={() => void removeEngine()}>删除引擎</button>
              </div>
            </div>
          )}

          <div style={subSection}>
            <h5 style={subTitle}>默认环境变量（使用该引擎的实例自动继承，实例可覆盖）</h5>
            <p style={hint}>
              可添加任意数量的自定义环境变量（如 ANTHROPIC_BASE_URL、API Key、代理地址等）。下方建议键可一键填入草稿。
            </p>
            <div style={envList}>
              {envVars.map((v) => {
                const editing = envEditing[v.key] !== undefined;
                const sensitive = v.sensitive ?? isSensitiveEnvVarKey(v.key);
                return (
                  <div key={v.key} style={envRow}>
                    <code style={{ color: '#f9e2af' }}>{v.key}</code>
                    {editing ? (
                      <input
                        style={{ ...input, flex: 2, minWidth: 140 }}
                        type={sensitive ? 'password' : 'text'}
                        value={envEditing[v.key] ?? ''}
                        onChange={(e) => setEnvEditing((prev) => ({ ...prev, [v.key]: e.target.value }))}
                        placeholder={sensitive ? '新值' : '新值'}
                        autoFocus
                      />
                    ) : (
                      <span style={{
                        color: sensitive ? '#6c7086' : '#a6e3a1',
                        fontSize: 12,
                        flex: 1,
                        fontFamily: 'monospace',
                        wordBreak: 'break-all',
                      }}>
                        {v.value}
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {editing ? (
                        <>
                          <button style={primaryBtn} disabled={busy} onClick={() => void updateExistingEnv(v.key)}>保存</button>
                          <button
                            style={secondaryBtn}
                            disabled={busy}
                            onClick={() => setEnvEditing((prev) => {
                              const next = { ...prev };
                              delete next[v.key];
                              return next;
                            })}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            style={smallBtn}
                            disabled={busy}
                            onClick={() => setEnvEditing((prev) => ({
                              ...prev,
                              // Prefill non-secrets so URLs/models are easy to tweak; secrets stay blank.
                              [v.key]: sensitive ? '' : v.value,
                            }))}
                          >
                            更新
                          </button>
                          <button style={dangerBtn} disabled={busy} onClick={() => void removeEnv(v.key)}>删除</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {envVars.length === 0 && <p style={hint}>尚未设置默认环境变量。</p>}
            </div>

            {missingHints.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: '#6c7086', fontSize: 12 }}>建议添加：</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {missingHints.map((h) => (
                    <button
                      key={h.key}
                      type="button"
                      style={hintChip}
                      title={h.description}
                      disabled={busy}
                      onClick={() => applySuggestedKey(h.key)}
                    >
                      {h.key}{h.optional ? '（可选）' : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {envDrafts.map((row, idx) => {
                const sensitive = isSensitiveEnvVarKey(row.key);
                return (
                  <div key={idx} style={addRow}>
                    <input
                      style={input}
                      placeholder="变量名"
                      value={row.key}
                      onChange={(e) => setEnvDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))}
                    />
                    <input
                      style={{ ...input, flex: 2 }}
                      type={sensitive ? 'password' : 'text'}
                      placeholder={sensitive ? '敏感值（将加密存储）' : '值'}
                      value={row.value}
                      onChange={(e) => setEnvDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))}
                    />
                    {envDrafts.length > 1 && (
                      <button
                        style={secondaryBtn}
                        disabled={busy}
                        onClick={() => setEnvDrafts((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        移除
                      </button>
                    )}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  style={secondaryBtn}
                  disabled={busy}
                  onClick={() => setEnvDrafts((prev) => [...prev, emptyEnvDraft()])}
                >
                  再加一行
                </button>
                <button style={primaryBtn} disabled={busy} onClick={() => void saveEnvDrafts()}>
                  {busy ? '保存中…' : '保存环境变量'}
                </button>
              </div>
            </div>
          </div>

          <div style={subSection}>
            <h5 style={subTitle}>工具审核策略（引擎默认）</h5>
            <ApprovalPolicyEditor value={approval} onChange={setApproval} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button style={primaryBtn} disabled={busy} onClick={() => void saveApproval()}>保存策略</button>
              {engine.approval && (
                <button style={secondaryBtn} disabled={busy} onClick={() => void clearApproval()}>清除（继承全局）</button>
              )}
            </div>
          </div>

          {notice && <p style={{ color: '#a6e3a1', fontSize: 13 }}>{notice}</p>}
          {err && <p style={{ color: '#f38ba8', fontSize: 13 }}>{err}</p>}
        </div>
      )}
    </div>
  );
}

function EngineSetupSection({
  engine,
  onChanged,
  onError,
  onNotice,
  onEnvHints,
}: {
  engine: EngineInfo;
  onChanged: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string | null) => void;
  onEnvHints?: (hints: EngineEnvVarHint[]) => void;
}) {
  const [guide, setGuide] = useState<EngineSetupGuide | null>(null);
  const [status, setStatus] = useState<EngineInstallStatus | null>(null);
  const [platformLabel, setPlatformLabel] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(engine.disabled === true);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string | null>(null);

  const loadSetup = async () => {
    setLoading(true);
    onError(null);
    try {
      const data = await api.engines.setup(engine.id);
      setGuide(data.guide);
      setStatus(data.status);
      setDisabled(data.disabled);
      setPlatformLabel(data.platformLabel);
      onEnvHints?.(data.guide.requiredEnvVars ?? []);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      onEnvHints?.([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSetup();
  }, [engine.id]);

  const enableEngine = async () => {
    setInstalling(true);
    onError(null);
    onNotice(null);
    try {
      await api.engines.setOverride(engine.id, { disabled: false });
      setDisabled(false);
      onNotice('引擎已启用。');
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const installAndEnable = async () => {
    setInstalling(true);
    onError(null);
    onNotice(null);
    setInstallLog(null);
    try {
      const result = await api.engines.install(engine.id);
      setStatus(result.status);
      if (result.stdout || result.stderr) {
        setInstallLog([result.stdout, result.stderr].filter(Boolean).join('\n').trim());
      }
      if (result.ok) {
        setDisabled(false);
        onNotice('安装完成，引擎已启用。');
        onChanged();
      } else {
        onError(result.status.checkError ?? '安装未完成，请查看输出或按文档手动安装。');
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  if (loading) {
    return (
      <div style={subSection}>
        <h5 style={subTitle}>环境与安装</h5>
        <p style={hint}>正在检测环境…</p>
      </div>
    );
  }

  if (!guide || !status) return null;

  const showInstallBtn = guide.installable && !status.installed;
  const showEnableBtn = status.installed && disabled;

  return (
    <div style={setupBlock}>
      <div style={setupHead}>
        <h5 style={{ ...subTitle, margin: 0 }}>环境与安装</h5>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {platformLabel && (
            <span style={{ ...tag, background: '#313244', color: '#89b4fa' }}>
              Hub 系统：{platformLabel}
            </span>
          )}
          <span style={{
            ...tag,
            background: status.installed ? '#3a4a2a' : '#452632',
            color: status.installed ? '#a6e3a1' : '#f38ba8',
          }}>
            {status.installed
              ? `已安装${status.version ? ` · ${status.version}` : ''}`
              : '未安装'}
          </span>
        </div>
      </div>

      <p style={{ ...hint, marginTop: 8 }}>
        {guide.summary}
        {platformLabel && (
          <span style={{ display: 'block', marginTop: 4, color: '#6c7086' }}>
            安装命令与检测均在运行 Hub 的机器上执行（当前为 {platformLabel}）。
          </span>
        )}
      </p>

      {guide.acpCommand && (
        <div style={cmdBlock}>
          <span style={{ color: '#6c7086', fontSize: 12 }}>ACP 上游命令</span>
          <code style={cmdCode}>{guide.acpCommand}</code>
        </div>
      )}

      {status.binaryPath && (
        <p style={{ color: '#a6adc8', fontSize: 12, margin: '6px 0' }}>
          检测到：<code style={{ color: '#f9e2af' }}>{status.binaryPath}</code>
        </p>
      )}

      <ol style={stepsList}>
        {guide.steps.map((step, i) => (
          <li key={i} style={stepItem}>
            <strong style={{ color: '#cdd6f4' }}>{step.title}</strong>
            <p style={{ margin: '4px 0 0', color: '#a6adc8', fontSize: 13 }}>{step.description}</p>
            {step.command && (
              <pre style={stepCmd}>{step.command}</pre>
            )}
          </li>
        ))}
      </ol>

      {guide.requiredEnvVars && guide.requiredEnvVars.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <span style={{ color: '#6c7086', fontSize: 12 }}>所需环境变量（可在下方「默认环境变量」配置）</span>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#a6adc8', fontSize: 13 }}>
            {guide.requiredEnvVars.map((v) => (
              <li key={v.key}>
                <code style={{ color: '#f9e2af' }}>{v.key}</code>
                {v.optional ? '（可选）' : ''} — {v.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' }}>
        {showInstallBtn && (
          <button style={primaryBtn} disabled={installing} onClick={() => void installAndEnable()}>
            {installing ? '安装中…' : '一键安装并启用'}
          </button>
        )}
        {showEnableBtn && (
          <button style={primaryBtn} disabled={installing} onClick={() => void enableEngine()}>
            启用引擎
          </button>
        )}
        <button style={secondaryBtn} disabled={installing} onClick={() => void loadSetup()}>
          重新检测
        </button>
        {guide.docsUrl && (
          <a href={guide.docsUrl} target="_blank" rel="noreferrer" style={docLink}>
            查看官方文档 ↗
          </a>
        )}
      </div>

      {installLog && (
        <pre style={installOutput}>{installLog}</pre>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────

const addBlock: React.CSSProperties = { background: '#181825', border: '1px solid #313244', borderRadius: 8, padding: 14 };
const addRow: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const sectionTitle: React.CSSProperties = { margin: '0 0 10px', color: '#cdd6f4', fontSize: 14 };
const hint: React.CSSProperties = { color: '#6c7086', fontSize: 12, margin: '0 0 10px' };
const listCol: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const row: React.CSSProperties = { background: '#181825', border: '1px solid #313244', borderRadius: 8, padding: 12 };
const rowHighlight: React.CSSProperties = { borderColor: '#89b4fa', boxShadow: '0 0 0 1px #89b4fa33' };
const rowHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const rowBody: React.CSSProperties = { marginTop: 12, borderTop: '1px solid #313244', paddingTop: 12 };
const subSection: React.CSSProperties = { marginBottom: 16 };
const subTitle: React.CSSProperties = { margin: '0 0 8px', color: '#a6adc8', fontSize: 13 };
const labelStyle: React.CSSProperties = { display: 'block', color: '#a6adc8', fontSize: 13, margin: '10px 0 6px' };
const input: React.CSSProperties = {
  flex: 1, minWidth: 120, boxSizing: 'border-box', padding: '8px 10px',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4',
};
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
  borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
};
const dangerBtn: React.CSSProperties = {
  background: '#452632', color: '#f38ba8', border: '1px solid #f38ba8',
  borderRadius: 5, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
};
const tag: React.CSSProperties = {
  fontSize: 11, padding: '1px 6px', background: '#313244', borderRadius: 4, color: '#cdd6f4',
};
const envList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 };
const envRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between',
  background: '#11111b', border: '1px solid #313244', borderRadius: 6, padding: '6px 10px', flexWrap: 'wrap',
};
const hintChip: React.CSSProperties = {
  background: '#1e1e2e', color: '#f9e2af', border: '1px solid #45475a',
  borderRadius: 999, padding: '3px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace',
};
const setupBlock: React.CSSProperties = {
  marginBottom: 16, padding: 12, background: '#11111b',
  border: '1px solid #313244', borderRadius: 8,
};
const setupHead: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap',
};
const cmdBlock: React.CSSProperties = { marginTop: 8 };
const cmdCode: React.CSSProperties = {
  display: 'block', marginTop: 4, padding: '8px 10px', background: '#181825',
  borderRadius: 6, color: '#a6e3a1', fontSize: 12, wordBreak: 'break-all',
};
const stepsList: React.CSSProperties = {
  margin: '12px 0 0', paddingLeft: 20, color: '#a6adc8',
};
const stepItem: React.CSSProperties = { marginBottom: 10 };
const stepCmd: React.CSSProperties = {
  margin: '6px 0 0', padding: '8px 10px', background: '#181825',
  borderRadius: 6, color: '#cdd6f4', fontSize: 12, overflow: 'auto',
};
const docLink: React.CSSProperties = {
  color: '#89b4fa', fontSize: 13, textDecoration: 'none',
};
const installOutput: React.CSSProperties = {
  marginTop: 10, padding: 10, background: '#181825', borderRadius: 6,
  color: '#a6adc8', fontSize: 11, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap',
};
