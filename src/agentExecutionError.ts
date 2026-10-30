/** Older Codex ACP adapters turn provider failures into assistant text followed by
 * end_turn. Accept only a whole error envelope, optionally after the adapter's
 * metadata warning; never scan quoted examples or tool output for error words. */
export function codexProviderError(output: string | undefined): string | undefined {
  const text = (output || '').trim().replace(/^Warning: Model metadata for [^\n]+ not found\. Defaulting to fallback metadata; this can degrade performance and cause issues\.\s*/, '');
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'error' || !('status' in value) || typeof value.status !== 'number' || value.status < 400 || value.status > 599 || !('error' in value)) return;
    const error = value.error;
    if (!error || typeof error !== 'object' || !('type' in error) || typeof error.type !== 'string' || !('message' in error) || typeof error.message !== 'string' || !error.message.trim()) return;
    return error.message.slice(0, 4000);
  } catch { return; }
}
