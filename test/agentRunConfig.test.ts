import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRunContext, renderRunModel, type AgentRunConfig } from '../public/agentRunConfig.js';
import { historyRunConfig } from '../public/historyComposer.js';

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

test('history continuation keeps the source working directory instead of falling back to the first project', () => {
  const projects = [
    { id: 'yonclaw', name: 'Codex', cwd: '/work/yonclaw1.0', deviceId: 'local', agent: 'codex' },
    { id: 'claude', name: 'Claude Code', cwd: '/work/auto-workflow', deviceId: 'local', agent: 'claude' }
  ];
  const config = historyRunConfig(projects, { agent: 'codex', cwd: '/work/auto-workflow' });
  assert.equal(config.projectIndex, 0, 'the same Agent remains selected when no target has the exact source cwd');
  assert.equal(config.cwd, '/work/auto-workflow', 'the source cwd overrides the selected target default');
  assert.match(renderRunContext(config), /auto-workflow/);
  assert.doesNotMatch(renderRunContext(config), />yonclaw1\.0</);
});
