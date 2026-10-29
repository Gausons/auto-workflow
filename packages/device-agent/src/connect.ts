import { validateDeviceDeployment } from '../../../shared/deviceDeployment.js';

export function parseDeployment(encoded: string) {
  if (encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('部署参数无效，请重新生成部署命令');
  try { return validateDeviceDeployment(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); }
  catch { throw new Error('部署参数无效，请重新生成部署命令'); }
}

export async function deploymentEnvironment(encoded: string, environment: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch) {
  const deployment = parseDeployment(encoded);
  if (deployment.expiresAt <= Date.now()) throw new Error('临时令牌已过期，请在网页重新生成部署命令');
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/auth/device-deployment/exchange', deployment.url), {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deploymentToken: deployment.deploymentToken }), signal: AbortSignal.timeout(30000)
    });
  } catch { throw new Error('令牌兑换结果未知，未自动重试或启动设备；请在网页重新生成部署命令'); }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? '临时令牌已使用或失效，请在网页重新生成部署命令' : `设备授权失败（${response.status}），请检查账号权限后重新生成部署命令`);
  if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) throw new Error('令牌兑换响应无效，未启动设备；请重新生成部署命令');
  const result: NodeJS.ProcessEnv = { ...environment, WORKBENCH_URL: deployment.url, WORKBENCH_TOKEN: data.token };
  delete result.WORKBENCH_USERNAME;
  delete result.WORKBENCH_PASSWORD;
  return result;
}
