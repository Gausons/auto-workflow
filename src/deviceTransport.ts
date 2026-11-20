import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { Agent, buildConnector, WebSocket as UndiciWebSocket } from 'undici';

const missingTrust = new Set([
  'CERT_UNTRUSTED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);
const invalidCertificate = new Set([...missingTrust,
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'INVALID_CA'
]);
const exec = promisify(execFile);
const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : '';

export class DeviceCertificateError extends Error {
  constructor() {
    super('无法验证工作台的 HTTPS 证书，请检查证书是否受本机信任、仍在有效期内且与访问地址匹配');
  }
}

async function verifyInKeychain(hostname: string, chain: Buffer[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-tls-'));
  try {
    const args = ['verify-cert', '-q', '-L', '-p', 'ssl', '-n', hostname];
    for (const [index, certificate] of chain.entries()) {
      const file = path.join(directory, `${index}.der`);
      await writeFile(file, certificate, { mode: 0o600 });
      args.push('-c', file);
    }
    await exec('/usr/bin/security', args, { timeout: 5000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function verifySocket(socket: TLSSocket, hostname: string, verify: typeof verifyInKeychain) {
  const peer = socket.getPeerCertificate(true);
  if (!peer.raw || checkServerIdentity(hostname, peer)) throw new DeviceCertificateError();
  const chain: Buffer[] = [];
  const seen = new Set<string>();
  for (let certificate = peer; certificate?.raw && !seen.has(certificate.fingerprint256); certificate = certificate.issuerCertificate) {
    seen.add(certificate.fingerprint256);
    chain.push(certificate.raw);
  }
  await verify(hostname, chain);
}

export function createMacTrustDispatcher(verify = verifyInKeychain) {
  const connect = buildConnector({ rejectUnauthorized: true });
  // Undici receives this socket only after macOS validates its exact peer chain.
  // Disable session resumption so the peer presents its certificates each time.
  const connectForVerification = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return new Agent({ connect(options, callback) {
    if (options.protocol !== 'https:') { connect(options, callback); return; }
    connect(options, (error, socket) => {
      if (!error && socket) { callback(null, socket); return; }
      if (!error) { callback(new Error('无法建立工作台 TLS 连接'), null); return; }
      if (!missingTrust.has(errorCode(error))) { callback(error, null); return; }
      connectForVerification(options, (handshakeError, candidate) => {
        if (handshakeError) { callback(handshakeError, null); return; }
        if (!(candidate instanceof TLSSocket)) { candidate?.destroy(); callback(new DeviceCertificateError(), null); return; }
        void verifySocket(candidate, options.hostname, verify).then(() => {
          if (candidate.destroyed) { callback(new Error('工作台 TLS 连接已断开'), null); return; }
          callback(null, candidate);
        }, () => {
          candidate.destroy();
          callback(new DeviceCertificateError(), null);
        });
      });
    });
  } });
}

// Keep Node's dispatcher when the user explicitly opts into environment proxies.
const nativeTrust = process.platform === 'darwin' && process.env.NODE_USE_ENV_PROXY !== '1' &&
  !process.execArgv.includes('--use-env-proxy') && !/(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? '')
  ? createMacTrustDispatcher() : undefined;

export const deviceFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const options = nativeTrust && url.protocol === 'https:' ? { ...init, dispatcher: nativeTrust } : init;
  try { return await fetch(input, options); }
  catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof DeviceCertificateError || invalidCertificate.has(errorCode(cause))) throw new DeviceCertificateError();
    throw error;
  }
};

export function openDeviceSocket(url: URL, protocol: string) {
  if (nativeTrust && url.protocol === 'wss:') {
    return new UndiciWebSocket(url, { protocols: protocol, dispatcher: nativeTrust });
  }
  return new WebSocket(url, protocol);
}
