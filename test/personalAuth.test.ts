import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../scripts/testing/database.js';

const password = 'personal-account-password';

test('personal registration stays open and isolates each account without an organization id', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bugflow-personal-auth-'));
  const app = createApp({ rootDir });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const request = async (endpoint: string, body: unknown) => {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() as Record<string, unknown> };
    };

    const [registered, duplicate] = await Promise.all([
      request('/api/auth/register', { username: 'person@example.com', displayName: '个人用户', password }),
      request('/api/auth/register', { username: 'person@example.com', displayName: '个人用户', password })
    ]).then(results => results.sort((left, right) => left.status - right.status));
    assert.equal(registered.status, 201);
    assert.equal(typeof registered.data.token, 'string');
    assert.equal((registered.data.user as { username: string }).username, 'person@example.com');
    assert.equal(duplicate.status, 409);

    const second = await request('/api/auth/register', { username: 'second@example.com', displayName: '第二位用户', password });
    assert.equal(second.status, 201);
    assert.notEqual((second.data.tenant as { id: string }).id, (registered.data.tenant as { id: string }).id);
    const members = async (token: unknown) => {
      const response = await fetch(base + '/api/organization/members', { headers: { Authorization: `Bearer ${String(token)}` } });
      assert.equal(response.status, 200);
      return (await response.json() as { members: Array<{ id: string; username: string }> }).members;
    };
    assert.deepEqual((await members(registered.data.token)).map(member => member.username), ['person@example.com']);
    assert.deepEqual((await members(second.data.token)).map(member => member.username), ['second@example.com']);
    const crossAccountUpdate = await fetch(`${base}/api/organization/members/${(registered.data.user as { id: string }).id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${String(second.data.token)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '越权修改' })
    });
    assert.equal(crossAccountUpdate.status, 404);

    const login = await request('/api/auth/login', { username: 'person@example.com', password });
    assert.equal(login.status, 200);
    assert.equal(typeof login.data.token, 'string');
    assert.equal((await request('/api/auth/login', { username: 'person@example.com', password: 'wrong-password' })).status, 401);
    const unavailableGoogle = await fetch(base + '/api/auth/google/start', { redirect: 'manual' });
    assert.equal(unavailableGoogle.status, 303);
    assert.match(new URL(unavailableGoogle.headers.get('location')!, base).searchParams.get('auth_error') || '', /Google 单点登录尚未配置/);
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Google SSO provisions an isolated account and reuses its Google identity', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bugflow-google-auth-'));
  const googleFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return new Response(JSON.stringify({ sub: 'google-subject', email: 'person@example.com', email_verified: true, name: 'Google Person' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    throw new Error(`Unexpected Google URL: ${url}`);
  };
  const app = createApp({ rootDir, fetchImpl: googleFetch, environment: {
    GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REDIRECT_URI: 'http://localhost/api/auth/google/callback'
  } });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const registration = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'person@example.com', displayName: '个人用户', password }) });
    const registered = await registration.json() as { tenant: { id: string } };

    const providers = await fetch(base + '/api/auth/providers');
    assert.deepEqual(await providers.json(), { google: true });
    const signIn = async () => {
      const start = await fetch(base + '/api/auth/google/start', { redirect: 'manual' });
      assert.equal(start.status, 302);
      const authorization = new URL(start.headers.get('location')!);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.equal(authorization.searchParams.get('scope'), 'openid email profile');
      const state = authorization.searchParams.get('state');
      assert.ok(state);
      const cookie = start.headers.get('set-cookie')!.split(';')[0];
      const callback = await fetch(`${base}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=authorization-code`, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(callback.status, 303);
      const exchangeCode = new URL(callback.headers.get('location')!, base).searchParams.get('google_login');
      assert.ok(exchangeCode);
      const exchange = await fetch(base + '/api/auth/google/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: exchangeCode }) });
      assert.equal(exchange.status, 200);
      return { exchangeCode, identity: await exchange.json() as { token: string; tenant: { id: string }; user: { id: string; hasGoogle: number } } };
    };

    const first = await signIn();
    assert.equal(typeof first.identity.token, 'string');
    assert.equal(first.identity.user.hasGoogle, 1);
    assert.notEqual(first.identity.tenant.id, registered.tenant.id);
    const second = await signIn();
    assert.equal(second.identity.tenant.id, first.identity.tenant.id);
    assert.equal(second.identity.user.id, first.identity.user.id);
    const replay = await fetch(base + '/api/auth/google/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: first.exchangeCode }) });
    assert.equal(replay.status, 401);
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Google SSO can register the first personal account', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'bugflow-google-register-'));
  const googleFetch: typeof fetch = async (input) => String(input).endsWith('/token')
    ? new Response(JSON.stringify({ access_token: 'google-access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(JSON.stringify({ sub: 'first-google-subject', email: 'first@example.com', email_verified: true, name: 'First User' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const app = createApp({ rootDir, fetchImpl: googleFetch, environment: {
    GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REDIRECT_URI: 'http://localhost/api/auth/google/callback'
  } });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const start = await fetch(base + '/api/auth/google/start', { redirect: 'manual' });
    const authorization = new URL(start.headers.get('location')!);
    const state = authorization.searchParams.get('state');
    assert.ok(state);
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const callback = await fetch(`${base}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=authorization-code`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const exchangeCode = new URL(callback.headers.get('location')!, base).searchParams.get('google_login');
    assert.ok(exchangeCode);
    const exchange = await fetch(base + '/api/auth/google/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: exchangeCode }) });
    assert.equal(exchange.status, 200);
    const identity = await exchange.json() as { token: string; user: { username: string; hasPassword: number; hasGoogle: number } };
    assert.equal(identity.user.username, 'first@example.com');
    assert.equal(identity.user.hasPassword, 0);
    assert.equal(identity.user.hasGoogle, 1);
    const setPassword = await fetch(base + '/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ password }) });
    assert.equal(setPassword.status, 200);
    const localLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'first@example.com', password }) });
    assert.equal(localLogin.status, 200);
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
