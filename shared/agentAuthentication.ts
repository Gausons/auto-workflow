/** Only format an execution error, never inspect Agent output or infer its outcome. */
export function agentAuthenticationMessage(message: string, agent?: string): string {
  if (!/^Authentication required(?:\s*[:：].*)?$/is.test(message.trim())) return message;
  const name = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude Code' : agent || 'Agent';
  return `目标设备上的 ${name} 需要认证。请在运行该 Agent 的设备上，以启动工作台或连接器的同一系统用户完成 Agent 登录，并检查其认证配置；认证完成后，请先核对原执行状态；不会自动重发原指令。`;
}
