export interface DeviceDeployment { url: string; deploymentToken: string; expiresAt: number }

export function validateDeviceDeployment(value: unknown): DeviceDeployment {
  if (!value || typeof value !== 'object') throw new Error('部署参数无效，请重新生成部署命令');
  const data = value as Record<string, unknown>;
  if (typeof data.url !== 'string' || data.url.length > 2048 || typeof data.deploymentToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.deploymentToken) || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt)) throw new Error('部署参数无效，请重新生成部署命令');
  const address = new URL(data.url);
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('工作台访问地址无效');
  if (address.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new Error('临时令牌仅支持 HTTPS 工作台，本机调试可使用 HTTP');
  return { url: address.origin, deploymentToken: data.deploymentToken, expiresAt: data.expiresAt };
}

export function deviceDeploymentCommand(value: unknown) {
  const config = validateDeviceDeployment(value);
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `npx --yes agent-workbench-connector@latest --connect ${encoded}`;
}
