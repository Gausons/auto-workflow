import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRunConfig, runDirectoryName, runEffortLabel, selectedAgentProject } from '../web/src/tasks/agentRunConfig.js';

test('history continuation keeps the source working directory and preferred agent', () => {
  const projects = [
    { id: 'yonclaw', name: 'Codex', cwd: '/work/yonclaw1.0', deviceId: 'local', agent: 'codex' },
    { id: 'claude', name: 'Claude Code', cwd: '/work/auto-workflow', deviceId: 'local', agent: 'claude' }
  ];
  const config = historyRunConfig(projects, { agent: 'codex', cwd: '/work/auto-workflow' });
  assert.equal(config.projectIndex, 0);
  assert.equal(config.cwd, '/work/auto-workflow');
  assert.equal(selectedAgentProject(config)?.id, 'yonclaw');
  assert.equal(runDirectoryName(config.cwd), 'auto-workflow');
  assert.equal(runEffortLabel('high'), '高');
});

test('cross-device continuation never silently carries a local directory', () => {
  const config = historyRunConfig([{ id: 'remote', cwd: '/remote', deviceId: 'remote', agent: 'codex' }], { agent: 'codex', cwd: '/local', deviceId: 'local' });
  assert.equal(config.cwd, '');
});
