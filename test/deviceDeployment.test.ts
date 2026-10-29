import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentEnvironment, parseDeployment } from '../packages/device-agent/src/connect.js';
import { deviceDeploymentCommand } from '../shared/deviceDeployment.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const config = () => ({ url: 'https://work.example.com', deploymentToken: 'd'.repeat(43), expiresAt: Date.now() + 600_000 });

test('deployment round trips safe shell arguments and rejects invalid or insecure addresses', () => {
  const value = config();
  assert.deepEqual(parseDeployment(deviceDeploymentCommand(value).split(' ').at(-1)!), value);
  for (const bad of ['', '$bad', 'a'.repeat(8193), encode(null), encode({}), encode({ ...value, deploymentToken: 'secret;$(bad)' }),
    ...['file:///tmp/file', 'http://work.example.com', 'https://user:pass@work.example.com', 'https://work.example.com/path', 'https://work.example.com/?token=secret'].map(url => encode({ ...value, url }))]) {
    assert.throws(() => parseDeployment(bad), /部署参数无效/);
  }
});

test('deployment exchanges once with no redirects, replaces inherited credentials and never saves a password', async () => {
  const old = { WORKBENCH_TOKEN: 'other-token', WORKBENCH_USERNAME: 'other', WORKBENCH_PASSWORD: 'old', WORKBENCH_URL: 'https://other.example.com', WORKBENCH_SYNC_EXCERPTS: 'false' };
  let calls = 0;
  const result = await deploymentEnvironment(encode(config()), old, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://work.example.com/api/auth/device-deployment/exchange');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { deploymentToken: 'd'.repeat(43) });
    assert.ok(!JSON.stringify(init).includes('other-token'));
    return new Response(JSON.stringify({ token: 's'.repeat(43) }));
  });
  assert.equal(calls, 1);
  assert.equal(result.WORKBENCH_TOKEN, 's'.repeat(43));
  assert.equal(result.WORKBENCH_USERNAME, undefined);
  assert.equal(result.WORKBENCH_PASSWORD, undefined);
  assert.equal(result.WORKBENCH_URL, 'https://work.example.com');
  assert.equal(result.WORKBENCH_SYNC_EXCERPTS, 'false');
  assert.equal(old.WORKBENCH_TOKEN, 'other-token');
});

test('expired, consumed, denied and uncertain exchanges never retry or leak secrets', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; throw new Error('secret-diagnostic'); };
  await assert.rejects(deploymentEnvironment(encode({ ...config(), expiresAt: 1 }), {}, fetchImpl), /已过期/);
  assert.equal(calls, 0);
  await assert.rejects(deploymentEnvironment(encode(config()), {}, fetchImpl), error => {
    assert.match(String(error), /结果未知/); assert.doesNotMatch(String(error), /secret-diagnostic/); return true;
  });
  assert.equal(calls, 1);
  for (const status of [401, 403, 500]) {
    await assert.rejects(deploymentEnvironment(encode(config()), {}, async () => new Response('server-secret', { status })), /临时令牌已使用或失效|设备授权失败/);
  }
  await assert.rejects(deploymentEnvironment(encode(config()), {}, async () => new Response('{}')), /响应无效/);
});
