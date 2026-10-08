/** Optional versioned report of prepared input, not proof of Agent understanding. */
export interface PreparedContextBrief {
  version: 1;
  snapshotId: string;
  snapshotDigest: string;
  intentDigest: string;
  text: string;
}

export function parsePreparedContextBrief(value: unknown): PreparedContextBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('交接单格式无效');
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.snapshotId !== 'string' || !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/.test(item.snapshotId) ||
      typeof item.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.snapshotDigest) ||
      typeof item.intentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.intentDigest) ||
      typeof item.text !== 'string' || !item.text.trim() || item.text.length > 3000) throw new Error('交接单格式无效');
  return { version: 1, snapshotId: item.snapshotId, snapshotDigest: item.snapshotDigest, intentDigest: item.intentDigest, text: item.text };
}
