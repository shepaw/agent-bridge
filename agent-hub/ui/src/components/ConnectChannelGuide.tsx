import { useState } from 'react';
import { useI18n } from '../i18n/index.js';
import { CHANNEL_CONSOLE_URL, CHANNEL_REPO_URL } from '../utils/appLinks.js';

/**
 * Read-only setup guides for the two "get off the LAN" paths on the
 * connect-client page: using a hosted/public Channel service, and running your
 * own. Commands are identical in every locale, so they live here as constants
 * instead of in the i18n tables.
 */
const DOCKER_CMD = `git clone https://github.com/shepaw/channel.git
cd channel
cp .env.example .env   # then set BASE_URL=https://channel.your-domain.com
docker-compose up -d`;

const BINARY_CMD = `# download channel-service_<os>_<arch> from
#   https://github.com/shepaw/channel/releases
chmod +x channel-service
./channel-service`;

const SOURCE_CMD = `git clone https://github.com/shepaw/channel.git
cd channel
go build -o channel-service ./pkg/cmd/
./channel-service`;

const CADDY_CMD = `channel.your-domain.com {
    reverse_proxy 127.0.0.1:8080
}`;

const NGINX_CMD = `server {
    listen 443 ssl;
    server_name channel.your-domain.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}`;

/** A command snippet with a copy button — users paste these into a terminal. */
export function CopyableCommand({ command }: { command: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div style={cmdBox}>
      <pre style={cmdPre}>{command}</pre>
      <button
        type="button"
        style={cmdCopyBtn}
        onClick={() => {
          try {
            void navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable — the text is selectable */
          }
        }}
      >
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  );
}

/** How to obtain Server URL / Channel ID / Secret from a hosted Channel service. */
export function PublicChannelGuide() {
  const { t } = useI18n();
  const steps = [
    t('connect.public.step1'),
    t('connect.public.step2'),
    t('connect.public.step3'),
    t('connect.public.step4'),
    t('connect.public.step5'),
    t('connect.public.step6'),
  ];
  return (
    <div style={guideBlock}>
      <h5 style={guideTitle}>{t('connect.public.title')}</h5>
      <a href={CHANNEL_CONSOLE_URL} target="_blank" rel="noreferrer" style={linkBtn}>
        {t('connect.public.openConsole')}
      </a>
      <ol style={orderedList}>
        {steps.map((step) => (
          <li key={step} style={listItem}>{step}</li>
        ))}
      </ol>
      <p style={note}>{t('connect.public.note')}</p>
    </div>
  );
}

/** Deploy-your-own walkthrough for the Channel service (github.com/shepaw/channel). */
export function SelfHostChannelGuide({ onDone }: { onDone?: () => void }) {
  const { t } = useI18n();
  return (
    <div style={guideBlock}>
      <h5 style={guideTitle}>{t('connect.selfhost.whoTitle')}</h5>
      <p style={para}>{t('connect.selfhost.whoBody')}</p>

      <h5 style={guideTitle}>{t('connect.selfhost.reqTitle')}</h5>
      <p style={para}>{t('connect.selfhost.reqBody')}</p>

      <h5 style={guideTitle}>{t('connect.selfhost.deployTitle')}</h5>
      <p style={subTitle}>{t('connect.selfhost.deployDocker')}</p>
      <CopyableCommand command={DOCKER_CMD} />
      <p style={subTitle}>{t('connect.selfhost.deployBinary')}</p>
      <CopyableCommand command={BINARY_CMD} />
      <p style={subTitle}>{t('connect.selfhost.deploySource')}</p>
      <CopyableCommand command={SOURCE_CMD} />
      <a href={CHANNEL_REPO_URL} target="_blank" rel="noreferrer" style={repoLink}>
        {t('connect.selfhost.openRepo')}
      </a>

      <h5 style={guideTitle}>{t('connect.selfhost.envTitle')}</h5>
      <p style={para}>{t('connect.selfhost.envBody')}</p>
      <p style={warn}>⚠ {t('connect.selfhost.envWarn')}</p>

      <h5 style={guideTitle}>{t('connect.selfhost.tlsTitle')}</h5>
      <p style={para}>{t('connect.selfhost.tlsBody')}</p>
      <CopyableCommand command={CADDY_CMD} />
      <CopyableCommand command={NGINX_CMD} />

      <h5 style={guideTitle}>{t('connect.selfhost.createTitle')}</h5>
      <p style={para}>{t('connect.selfhost.createBody')}</p>

      <h5 style={guideTitle}>{t('connect.selfhost.backTitle')}</h5>
      <p style={para}>{t('connect.selfhost.backBody')}</p>
      {onDone && (
        <button type="button" style={nextBtn} onClick={onDone}>
          {t('connect.gotoChannel')}
        </button>
      )}

      <p style={note}>{t('connect.selfhost.noInbound')}</p>

      <h5 style={guideTitle}>{t('connect.selfhost.troubleTitle')}</h5>
      <ul style={bulletList}>
        <li style={listItem}>{t('connect.selfhost.trouble1')}</li>
        <li style={listItem}>{t('connect.selfhost.trouble2')}</li>
        <li style={listItem}>{t('connect.selfhost.trouble3')}</li>
      </ul>
    </div>
  );
}

const guideBlock: React.CSSProperties = {
  marginTop: 12,
  padding: '12px 14px',
  background: '#11111b',
  border: '1px solid #313244',
  borderRadius: 6,
  textAlign: 'left',
};
const guideTitle: React.CSSProperties = {
  margin: '14px 0 6px',
  color: '#cdd6f4',
  fontSize: 13,
  fontWeight: 600,
};
const subTitle: React.CSSProperties = {
  margin: '12px 0 4px',
  color: '#a6adc8',
  fontSize: 12,
};
const para: React.CSSProperties = {
  margin: 0,
  color: '#a6adc8',
  fontSize: 12,
  lineHeight: 1.6,
};
const note: React.CSSProperties = {
  margin: '12px 0 0',
  color: '#6c7086',
  fontSize: 11,
  lineHeight: 1.6,
};
const warn: React.CSSProperties = {
  margin: '8px 0 0',
  color: '#f9e2af',
  fontSize: 12,
  lineHeight: 1.6,
};
const orderedList: React.CSSProperties = {
  margin: '10px 0 0',
  paddingLeft: 20,
  color: '#cdd6f4',
  fontSize: 12,
  lineHeight: 1.7,
};
const bulletList: React.CSSProperties = {
  margin: '6px 0 0',
  paddingLeft: 20,
  color: '#a6adc8',
  fontSize: 12,
  lineHeight: 1.7,
};
const listItem: React.CSSProperties = { marginBottom: 4 };
const linkBtn: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 10,
  background: '#89b4fa',
  color: '#11111b',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  textDecoration: 'none',
};
const repoLink: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 10,
  color: '#89b4fa',
  fontSize: 12,
  textDecoration: 'none',
};
const nextBtn: React.CSSProperties = {
  marginTop: 12,
  background: '#89b4fa',
  color: '#1e1e2e',
  border: 'none',
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
const cmdBox: React.CSSProperties = {
  position: 'relative',
  background: '#181825',
  border: '1px solid #313244',
  borderRadius: 6,
  padding: '8px 8px 8px 10px',
  marginTop: 6,
};
const cmdPre: React.CSSProperties = {
  margin: 0,
  paddingRight: 60,
  color: '#89dceb',
  fontSize: 11,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const cmdCopyBtn: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  background: '#313244',
  color: '#cdd6f4',
  border: '1px solid #45475a',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
};
