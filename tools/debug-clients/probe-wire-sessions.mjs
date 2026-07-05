// Over-the-wire test: drive the DEPLOYED peer pipeline
// (core PeerAcpClient -> restarted acp-proxy onSessionsList) against a real
// running instance, exactly as the peer-daemon does when a phone asks.
import core from '../../agent-hub/core/dist/index.cjs';
import sdk from '../../sdks/shepaw-acp-sdk-typescript/dist/index.cjs';

const { PeerAcpClient, loadOrCreatePeerIdentity, loadOrCreateHubConfig, instancePaths } = core;
const { loadOrCreateIdentity } = sdk;

const instanceId = process.argv[2] ?? 'shepaw';

const cfg = loadOrCreateHubConfig();
const instance = cfg.instances.find((i) => i.id === instanceId);
if (!instance) { console.error(`no instance ${instanceId}`); process.exit(1); }

const peerIdentity = loadOrCreatePeerIdentity();
const instanceIdentity = loadOrCreateIdentity({ path: instancePaths(instance.id).identityPath });

const client = new PeerAcpClient(peerIdentity, instance, instanceIdentity, (l) => console.log('[client]', l));

console.log(`[probe] calling agent.sessions.list on instance "${instanceId}" (${instance.engine}, ${instance.host}:${instance.port})`);
const sessions = await client.sessions();
console.log(`[probe] got ${sessions.length} sessions over the wire:`);
console.log(JSON.stringify(sessions.slice(0, 6), null, 2));

client.close?.();
process.exit(0);
