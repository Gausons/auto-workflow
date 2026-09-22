import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRunContext, renderRunModel, type AgentRunConfig } from '../public/agentRunConfig.js';

test('shared agent run configuration renders the same environment and model controls', () => {
  const config: AgentRunConfig = { projects: [{ id: 'project', name: 'auto-workflow', cwd: '/work/auto-workflow', deviceId: 'local', deviceName: '工作台所在设备', online: true, defaultModel: 'gpt-test', models: [{ id: 'gpt-test', name: 'GPT Test', reasoningEfforts: [{ id: 'low', name: '低' }] }] }], projectIndex: 0, cwd: '', model: 'gpt-test', reasoningEffort: 'low' };
  const context = renderRunContext(config, { branch: '<span data-branch>main</span>' });
  const model = renderRunModel(config);
  assert.match(context, /auto-workflow/);
  assert.match(context, /工作台所在设备/);
  assert.match(context, /tc-create-cwd/);
  assert.match(context, /data-branch>main/);
  assert.match(model, /GPT Test/);
  assert.match(model, /低/);
});
