import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import type { SystemVersion } from '../api/types.js';
import { useI18n } from '../i18n/index.js';
import { ConfirmModal } from './ConfirmModal.js';

/**
 * Version & update card (Settings → 全局): installed version, npm update
 * check, one-click upgrade, and dashboard server restart. The restart
 * endpoint makes the supervised child exit; the `shepaw-hub web` supervisor
 * respawns it, so after an upgrade the new npm package actually runs.
 */
export function VersionPanel() {
  const { t } = useI18n();
  const [version, setVersion] = useState<SystemVersion | null>(null);
  const [checking, setChecking] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<'none' | 'restart' | 'upgrade'>('none');

  const loadVersion = async () => {
    try {
      setVersion(await api.system.version());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadVersion();
  }, []);

  const checkUpdates = async () => {
    setChecking(true);
    setErr(null);
    try {
      setVersion(await api.system.version(true));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(t('settings.checkFailed', { message }));
    } finally {
      setChecking(false);
    }
  };

  const upgrade = async () => {
    setUpgradeBusy(true);
    setErr(null);
    try {
      const res = await api.system.upgrade();
      setVersion((v) => (v ? { ...v, installed: res.installed } : v));
      setModal('upgrade');
    } catch (e) {
      setErr(upgradeErrorMessage(e));
    } finally {
      setUpgradeBusy(false);
    }
  };

  const upgradeErrorMessage = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    const code = e instanceof Error ? (e as Error & { code?: string }).code : undefined;
    switch (code) {
      case 'not-npm-install':
        return t('settings.notNpmInstall');
      case 'upgrade-in-flight':
        return t('settings.upgradeInFlight');
      case 'npm-install-failed':
        return t('settings.upgradeFailed', { message });
      default:
        return t('settings.upgradeFailed', { message });
    }
  };

  /** Poll the (public) health endpoint until the restarted server is back. */
  const waitForServer = async (attempts = 30, intervalMs = 2000): Promise<void> => {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) return;
      } catch {
        // server down — expected during restart
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(t('settings.waitingServerFailed'));
  };

  const confirmRestart = async () => {
    setRestarting(true);
    setErr(null);
    try {
      await api.system.restart();
      await waitForServer();
      window.location.reload();
    } catch (e) {
      const code = e instanceof Error ? (e as Error & { code?: string }).code : undefined;
      setErr(
        code === 'not-supervised'
          ? t('settings.restartNotSupervised')
          : code === 'upgrade-in-flight'
            ? t('settings.upgradeInFlight')
            : e instanceof Error ? e.message : String(e),
      );
      setModal('none');
    } finally {
      setRestarting(false);
    }
  };

  const closeModal = () => {
    if (!restarting) setModal('none');
  };

  const outdated = version?.outdated === true;
  const upToDate = version?.latest !== undefined && outdated === false;

  return (
    <section style={card}>
      <h3 style={cardTitle}>{t('settings.versionTitle')}</h3>
      <p style={cardHint}>{t('settings.versionHint')}</p>

      {version !== null && (
        <p style={statusLine}>
          {t('settings.installed', { version: version.installed })}
          {outdated && (
            <span style={{ color: '#f9e2af' }}>{' · '}{t('settings.updateAvailable', { latest: version.latest ?? '' })}</span>
          )}
          {upToDate && (
            <span style={{ color: '#a6e3a1' }}>{' · '}{t('settings.versionUpToDate', { latest: version.latest ?? '' })}</span>
          )}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button style={secondaryBtn} disabled={checking || upgradeBusy || restarting} onClick={() => void checkUpdates()}>
          {checking ? t('settings.checkingUpdates') : t('settings.checkUpdates')}
        </button>
        {version?.npmInstall && outdated && (
          <button style={primaryBtn} disabled={checking || upgradeBusy || restarting} onClick={() => void upgrade()}>
            {upgradeBusy ? t('settings.upgrading') : t('settings.upgrade')}
          </button>
        )}
        {version?.supervised && (
          <button
            style={secondaryBtn}
            disabled={checking || upgradeBusy || restarting}
            onClick={() => setModal('restart')}
          >
            {restarting ? t('settings.restarting') : t('settings.restart')}
          </button>
        )}
      </div>

      {version?.npmInstall === false && (
        <p style={warn}>{t('settings.notNpmInstall')}</p>
      )}
      {restarting && (
        <p style={{ color: '#a6e3a1', fontSize: 13, marginTop: 10 }}>{t('settings.waitingServer')}</p>
      )}
      {err && <p style={{ color: '#f38ba8', fontSize: 13, marginTop: 10 }}>{err}</p>}

      {modal === 'restart' && (
        <ConfirmModal
          title={t('settings.restartTitle')}
          message={t('settings.restartMessage')}
          confirmLabel={t('settings.restart')}
          cancelLabel={t('common.cancel')}
          tone="danger"
          busy={restarting}
          onConfirm={() => void confirmRestart()}
          onCancel={closeModal}
        />
      )}
      {modal === 'upgrade' && (
        <ConfirmModal
          title={t('settings.upgradeRestartTitle')}
          message={t('settings.upgradeRestartMessage', { version: version?.installed ?? '' })}
          confirmLabel={t('settings.upgradeRestartButton')}
          cancelLabel={t('common.cancel')}
          tone="primary"
          busy={restarting}
          onConfirm={() => void confirmRestart()}
          onCancel={closeModal}
        />
      )}
    </section>
  );
}

const card: React.CSSProperties = {
  background: '#1e1e2e', border: '1px solid #313244', borderRadius: 10, padding: '20px 24px',
};
const cardTitle: React.CSSProperties = { margin: '0 0 4px', color: '#cdd6f4', fontSize: 16 };
const cardHint: React.CSSProperties = { margin: '0 0 16px', color: '#a6adc8', fontSize: 13 };
const statusLine: React.CSSProperties = { margin: '0', color: '#cdd6f4', fontSize: 13 };
const warn: React.CSSProperties = { margin: '10px 0 0', color: '#f9e2af', fontSize: 13 };
const primaryBtn: React.CSSProperties = {
  background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 6,
  padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
const secondaryBtn: React.CSSProperties = {
  background: 'transparent', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600,
};
