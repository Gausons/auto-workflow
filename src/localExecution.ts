export function localExecutionEnabled(environment: Record<string, string | undefined>): boolean {
  const value = environment.LOCAL_EXECUTION_ENABLED?.trim().toLowerCase();
  if (value !== undefined) {
    if (['false', '0', 'no', 'off'].includes(value)) return false;
    if (['true', '1', 'yes', 'on'].includes(value)) return true;
    throw new Error('LOCAL_EXECUTION_ENABLED 必须为 true 或 false');
  }
  // Compatibility with the original cloud deployment's explicit disabled sentinel.
  return !(environment.ACP_ENABLED === 'false' && environment.CODEX_EXECUTABLE === '/nonexistent/codex');
}
