const base = 'http://127.0.0.1:4173';
try {
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (health.status !== 200) throw new Error('Database health check failed');
  const page = await fetch(`${base}/devices`, { signal: AbortSignal.timeout(3000) });
  if (page.status !== 200) throw new Error('Page health check failed');
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(match => match[1]);
  if (!assets.length) throw new Error('Built assets missing');
  for (const asset of assets) {
    const response = await fetch(`${base}${asset}`, { signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) throw new Error('Asset health check failed');
    await response.arrayBuffer();
  }
  const auth = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(3000) });
  if (auth.status !== 401) throw new Error('Authentication boundary check failed');
} catch {
  console.error('Container health check failed');
  process.exitCode = 1;
}
