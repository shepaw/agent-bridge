import { ApprovalSettingsPanel } from './GatewaySettingsModal.js';
import { EngineManager } from './EngineManager.js';
import { HubAuthTokenPanel } from './HubAuthTokenPanel.js';
import { PeerPairingPanel } from './PeerPairingPanel.js';
import type { SettingsTab } from '../utils/settingsRoute.js';

/**
 * Settings content panels (nav lives in App shell).
 *   - 全局: dashboard auth token + device-wide tool-call approval default
 *   - 引擎: opened from Create Instance「管理引擎」(not a left-nav item)
 *   - 扫码配对: peer service + shepaw://peer QR + optional channel
 */

export function SettingsPage({
  tab,
  focusEngineId,
  onFocusEngineHandled,
  onAuthTokenSaved,
}: {
  tab: SettingsTab;
  focusEngineId: string | null;
  onFocusEngineHandled: () => void;
  onAuthTokenSaved?: () => void;
}) {
  return (
    <>
      {tab === 'global' && (
        <div style={panel}>
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
        </div>
      )}

      {tab === 'engines' && (
        <section style={card}>
          <h3 style={cardTitle}>引擎管理</h3>
          <p style={cardHint}>管理内置与自定义引擎，配置每个引擎的默认环境变量与审核策略。</p>
          <EngineManager
            focusEngineId={focusEngineId}
            onFocusEngineHandled={onFocusEngineHandled}
          />
        </section>
      )}

      {tab === 'peer' && (
        <section style={card}>
          <h3 style={cardTitle}>扫码配对</h3>
          <p style={cardHint}>
            先启动 Peer 服务，再用 Shepaw App「Device Pairing / Scan to Connect」扫码。
            配对后手机可通过 peer 通道访问本机全部实例。
          </p>
          <PeerPairingPanel />
        </section>
      )}
    </>
  );
}

const panel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16 };
const card: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, padding: '20px 24px',
};
const cardTitle: React.CSSProperties = { margin: '0 0 4px', color: '#cdd6f4', fontSize: 16 };
const cardHint: React.CSSProperties = { margin: '0 0 16px', color: '#a6adc8', fontSize: 13 };
const inlineCode: React.CSSProperties = {
  background: '#181825', border: '1px solid #313244', borderRadius: 4, padding: '0 4px',
};
