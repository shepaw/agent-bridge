import { useState } from 'react';
import { GatewaySettingsPanel } from './GatewaySettingsModal.js';
import { DevicePairingPanel } from './DevicePairingModal.js';
import { EngineManager } from './EngineManager.js';

type Tab = 'global' | 'engines';

/**
 * Unified settings page. Hosts the three configuration surfaces:
 *   - 全局: shared channel + tunnel router + device-wide approval + device pairing
 *   - 引擎: per-engine overrides (enable/disable, command, default creds, approval)
 *
 * Instances (agent instances) live on the main dashboard; per-instance approval
 * is edited in InstanceDetail.
 */
export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('global');

  return (
    <div>
      <div style={tabs}>
        <button style={tabBtn(tab === 'global')} onClick={() => setTab('global')}>全局设置</button>
        <button style={tabBtn(tab === 'engines')} onClick={() => setTab('engines')}>引擎管理</button>
      </div>

      <div style={panel}>
        {tab === 'global' && (
          <>
            <section style={card}>
              <h3 style={cardTitle}>网关 / 共享 Channel + 审核策略</h3>
              <p style={cardHint}>一个 channel 代理本机全部 Agent；设备级默认审核策略在此设置。</p>
              <GatewaySettingsPanel />
            </section>
            <section style={card}>
              <h3 style={cardTitle}>设备配对</h3>
              <p style={cardHint}>用 Shepaw App 扫描一次，授权本机上的全部 Agent。</p>
              <DevicePairingPanel />
            </section>
          </>
        )}

        {tab === 'engines' && (
          <section style={card}>
            <h3 style={cardTitle}>引擎管理</h3>
            <p style={cardHint}>管理内置与自定义引擎，配置每个引擎的默认凭据与审核策略。</p>
            <EngineManager />
          </section>
        )}
      </div>
    </div>
  );
}

const tabs: React.CSSProperties = { display: 'flex', gap: 8, marginBottom: 16 };
const tabBtn = (active: boolean): React.CSSProperties => ({
  background: active ? '#89b4fa' : 'transparent',
  color: active ? '#1e1e2e' : '#cdd6f4',
  border: `1px solid ${active ? '#89b4fa' : '#45475a'}`,
  borderRadius: 6, padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 14,
});
const panel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const card: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, padding: '20px 24px',
};
const cardTitle: React.CSSProperties = { margin: '0 0 4px', color: '#cdd6f4', fontSize: 16 };
const cardHint: React.CSSProperties = { margin: '0 0 16px', color: '#a6adc8', fontSize: 13 };
