/** Keep the selected engine visible even when a group participant has a custom name. */
export function agentDisplayName(agent?: string, label?: string): string {
  const name = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude Code' : agent || '';
  if (!name) return label || 'Agent';
  return label && label !== agent && label !== name ? `${label}（${name}）` : name;
}
