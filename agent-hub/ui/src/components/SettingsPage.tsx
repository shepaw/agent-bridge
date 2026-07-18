import { ApprovalSettingsPanel } from './GatewaySettingsModal.js';
import { EngineManager } from './EngineManager.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { PeerPairingPanel } from './PeerPairingPanel.js';
import type { SettingsTab } from '../utils/settingsRoute.js';

/**
 * Unified settings page. Hosts the three configuration surfaces:
 *   - 全局: dashboard auth token + device-wide tool-call approval default
 *   - 引擎: per-engine overrides (enable/disable, command, default creds, approval)
 *   - Peer 配对: shared channel + peer service + shepaw://peer pairing
 *
 * Instances (agent instances) live on the main dashboard; per-instance approval
 * is edited in InstanceDetail.
 */
export function SettingsPage({
  tab,
  onTabChange,
  focusEngineId,
  onFocusEngineHandled,
  onAuthTokenSaved,
}: {
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  focusEngineId: string | null;
  onFocusEngineHandled: () => void;
  onAuthTokenSaved?: () => void;
}) {
  return (
    <div>
      <div style={tabs}>
        <button style={tabBtn(tab === 'global')} onClick={() => onTabChange('global')}>全局设置</button>
        <button style={tabBtn(tab === 'engines')} onClick={() => onTabChange('engines')}>引擎管理</button>
        <button style={tabBtn(tab === 'peer')} onClick={() => onTabChange('peer')}>Peer 配对</button>
      </div>

      <div style={panel}>
        {tab === 'global' && (
          <>
            <section style={card}>
              <h3 style={cardTitle}>Dashboard 鉴权 Token</h3>
              <p style={cardHint}>
                当 Hub 以 <code style={inlineCode}>SHEPAW_HUB_TOKEN</code> 启动时，浏览器需保存同一 Token，
                才能访问 Peer / Channel 等 API。Token 仅存于本机 localStorage。
              </p>
              <HubAuthTokenPanel onSaved={onAuthTokenSaved} />
            </section>
            <section style={card}>
              <h3 style={cardTitle}>工具调用审核策略（设备级默认）</h3>
              <p style={cardHint}>决定本机 Agent 的默认工具审核行为；引擎或实例可单独覆盖。</p>
              <ApprovalSettingsPanel />
            </section>
          </>
        )}

        {tab === 'engines' && (
          <section style={card}>
            <h3 style={cardTitle}>引擎管理</h3>
            <p style={cardHint}>管理内置与自定义引擎，配置每个引擎的默认凭据与审核策略。</p>
            <EngineManager
              focusEngineId={focusEngineId}
              onFocusEngineHandled={onFocusEngineHandled}
            />
          </section>
        )}

        {tab === 'peer' && (
          <section style={card}>
            <h3 style={cardTitle}>Peer 配对（shepaw://peer）</h3>
            <p style={cardHint}>
              配置 Channel 后启动 Peer 服务并生成二维码，用 Shepaw App 的「Device Pairing / Scan to Connect」扫码。
              配对后手机可通过 peer 通道访问本机全部实例。
            </p>
            <PeerPairingPanel />
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
const inlineCode: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px',
};
