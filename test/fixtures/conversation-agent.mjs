// Deterministic ACP peer for protocol/HTTP/UI integration tests; no external model calls.
import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
const sessions = new Map();
acp.agent({ name: 'conversation-fixture' })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'fixture', version: '1' } }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = randomUUID(); sessions.set(sessionId, 0); return { sessionId, configOptions: [] };
  })
  .onRequest(acp.methods.agent.session.close, () => ({}))
  .onRequest(acp.methods.agent.session.load, async ctx => {
    sessions.set(ctx.params.sessionId, 1);
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY_SHOULD_NOT_APPEAR' } } });
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ctx => {
    const text = ctx.params.prompt.filter(p => p.type === 'text').map(p => p.text).join('\n');
    const count = (sessions.get(ctx.params.sessionId) || 0) + 1;
    sessions.set(ctx.params.sessionId, count);
    const output = text.includes('inherited_context')
      ? `已继承上下文：${text.includes('保持原接口兼容') ? '保持原接口兼容' : '历史可用'}；收到：${text.split('本轮用户消息：\n').at(-1)}`
      : `同一会话第 ${count} 轮：${text}`;
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'test-tool', title: '检查上下文', kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '工具结果已保留' } }] } });
    await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output } } });
    return { stopReason: 'end_turn' };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
