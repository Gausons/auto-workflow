import { AI_ASSIGNMENT_MODELS, DEFAULT_AI_ASSIGNMENT_MODEL } from '../shared/assignmentModels.js';
import type { AssignmentModelConnection, PublicAssignmentModelConnection } from '../shared/assignmentModels.js';
import { assignmentModelId, DEFAULT_OPENAI_BASE_URL, modelApiKey, modelBaseUrl } from './assignmentModelConnection.js';
import type { Environment } from './issueSources/types.js';
import { httpError } from './rbac.js';

type SettingsInput = Record<string, unknown>;
interface SavedConnection extends AssignmentModelConnection { apiKey?: string }
interface ModelSettings { model: string; connections: SavedConnection[]; revision: number; legacy: boolean }
interface DeploymentConnection { baseUrl: string; apiKey?: string; model: string; timeoutMs: number }

const presets = AI_ASSIGNMENT_MODELS.map(model => model.id);
const presetIds = new Set<string>(presets);
const defaultTimeout = 30000;
const defaultTimeoutFor = (value: unknown) => {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.trunc(Math.min(120000, Math.max(5000, timeout))) : defaultTimeout;
};

function baseUrlOr(value: unknown, fallback: string) {
  try { return modelBaseUrl(value); } catch { return fallback; }
}

function timeoutMs(value: unknown, fallback = defaultTimeout) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5000 || value > 120000) {
    throw httpError(400, 'OpenAI 请求超时必须为 5000–120000 毫秒');
  }
  return value;
}

function withKey(connection: AssignmentModelConnection, input: unknown, savedKey?: string): SavedConnection {
  const key = input === undefined ? savedKey : input === null ? undefined : modelApiKey(input);
  return key ? { ...connection, apiKey: key } : connection;
}

function readConnections(input: unknown, saved: SavedConnection[]): SavedConnection[] {
  if (!Array.isArray(input)) throw httpError(400, '模型连接列表格式无效');
  const urls = new Set<string>();
  const boundModels = new Set<string>();
  const savedByUrl = new Map(saved.map(connection => [connection.baseUrl, connection]));
  return input.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '模型连接配置格式无效');
    const { baseUrl: address, models: items, apiKey, timeoutMs: timeout } = value as SettingsInput;
    const baseUrl = modelBaseUrl(address);
    if (urls.has(baseUrl)) throw httpError(400, `Base URL 已存在：${baseUrl}`);
    urls.add(baseUrl);
    if (!Array.isArray(items)) throw httpError(400, '模型列表格式无效');
    const models = items.map((item: unknown) => {
      const model = assignmentModelId(item);
      if (boundModels.has(model)) throw httpError(400, `模型 ID 重复：${model}。每个模型只能绑定一个 Base URL`);
      boundModels.add(model);
      return model;
    });
    const previous = savedByUrl.get(baseUrl);
    return withKey({ baseUrl, models, timeoutMs: timeoutMs(timeout, previous?.timeoutMs) }, apiKey, previous?.apiKey);
  });
}

export function assignmentModelDeployment(environment: Environment): DeploymentConnection {
  const baseUrl = baseUrlOr(environment.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL, '');
  return {
    baseUrl, apiKey: baseUrl ? environment.OPENAI_API_KEY?.trim() : undefined,
    model: environment.AI_ASSIGNMENT_MODEL?.trim() || DEFAULT_AI_ASSIGNMENT_MODEL,
    timeoutMs: defaultTimeoutFor(environment.OPENAI_TIMEOUT_MS ?? environment.AI_ROUTING_TIMEOUT_MS)
  };
}

export function loadAssignmentModelSettings(config: SettingsInput, deployment: DeploymentConnection): ModelSettings {
  const revision = typeof config.modelConfigRevision === 'number' && Number.isSafeInteger(config.modelConfigRevision) ? config.modelConfigRevision : 0;
  const model = typeof config.aiAssignmentModel === 'string' ? config.aiAssignmentModel.trim() : deployment.model;
  if (config.openaiModelConnections !== undefined) {
    const connections = readConnections(config.openaiModelConnections, []);
    return { connections, model: connections.some(connection => connection.models.includes(model)) ? model : '', revision, legacy: false };
  }
  const models = new Set<string>(presets);
  if (Array.isArray(config.aiAssignmentCustomModels)) for (const item of config.aiAssignmentCustomModels) {
    if (typeof item === 'string' && item.trim()) models.add(item.trim());
  }
  const selectedModel = model || DEFAULT_AI_ASSIGNMENT_MODEL;
  models.add(selectedModel);
  const connection = {
    baseUrl: baseUrlOr(config.openaiBaseUrl ?? config.aiRoutingBaseUrl, deployment.baseUrl || DEFAULT_OPENAI_BASE_URL),
    timeoutMs: defaultTimeoutFor(config.openaiTimeoutMs ?? config.aiRoutingTimeoutMs ?? deployment.timeoutMs),
    models: [...models]
  };
  const apiKey = typeof config.openaiApiKey === 'string' ? config.openaiApiKey.trim() : '';
  return { model: selectedModel, revision, legacy: true, connections: [apiKey ? { ...connection, apiKey } : connection] };
}

export function assignmentConnectionFor(settings: ModelSettings, model = settings.model) {
  return settings.connections.find(connection => connection.models.includes(model));
}

export function assignmentConnectionKey(connection: SavedConnection, deployment: DeploymentConnection) {
  return connection.apiKey || (connection.baseUrl === deployment.baseUrl ? deployment.apiKey : undefined);
}

export function updateAssignmentModelSettings(current: ModelSettings, input: SettingsInput): ModelSettings {
  const { expectedModelConfigRevision, openaiModelConnections, aiAssignmentModel, openaiBaseUrl, openaiTimeoutMs, openaiApiKey } = input;
  const legacyPatch = [openaiBaseUrl, openaiTimeoutMs, openaiApiKey].some(value => value !== undefined);
  if (openaiModelConnections !== undefined && expectedModelConfigRevision === undefined) throw httpError(400, '保存模型连接需要提供当前配置版本');
  if (expectedModelConfigRevision !== undefined && expectedModelConfigRevision !== current.revision) {
    throw httpError(409, '模型配置已更新，请刷新页面后重试');
  }
  if (legacyPatch && (!current.legacy || openaiModelConnections !== undefined)) throw httpError(400, '请通过 Base URL 列表修改模型连接');

  const legacy = current.legacy && openaiModelConnections === undefined && (aiAssignmentModel !== '' || legacyPatch);
  let model = aiAssignmentModel === undefined ? current.model : aiAssignmentModel === '' && !legacy ? '' : assignmentModelId(aiAssignmentModel);
  let connections = current.connections;
  if (openaiModelConnections !== undefined) connections = readConnections(openaiModelConnections, current.connections);
  if (legacy && (legacyPatch || model !== current.model)) {
    const previous = current.connections[0];
    const baseUrl = openaiBaseUrl === undefined ? previous.baseUrl : modelBaseUrl(openaiBaseUrl);
    const addingModel = !previous.models.includes(model);
    if (addingModel && previous.models.filter(id => !presetIds.has(id)).length >= 50) throw httpError(400, '请通过 Base URL 列表添加更多模型');
    const models = addingModel ? [...previous.models, model] : previous.models;
    connections = [withKey({ baseUrl, models, timeoutMs: timeoutMs(openaiTimeoutMs, previous.timeoutMs) }, openaiApiKey,
      baseUrl === previous.baseUrl ? previous.apiKey : undefined)];
  }
  if (model && !connections.some(connection => connection.models.includes(model))) {
    if (aiAssignmentModel !== undefined) throw httpError(400, '请选择已绑定 Base URL 的 AI 分配模型');
    model = '';
  }
  if (model === current.model && legacy === current.legacy && JSON.stringify(connections) === JSON.stringify(current.connections)) return current;
  return { model, connections, legacy, revision: current.revision + 1 };
}

export function assignmentModelProbe(settings: ModelSettings, deployment: DeploymentConnection, input: SettingsInput) {
  const model = input.aiAssignmentModel === undefined ? settings.model : assignmentModelId(input.aiAssignmentModel);
  if (!model) throw httpError(400, '请选择要测试的模型');
  const baseUrl = input.openaiBaseUrl === undefined
    ? assignmentConnectionFor(settings, model)?.baseUrl ?? (settings.legacy ? settings.connections[0].baseUrl : '')
    : modelBaseUrl(input.openaiBaseUrl);
  if (!baseUrl) throw httpError(400, '请输入模型的 Base URL');
  const previous = settings.connections.find(connection => connection.baseUrl === baseUrl);
  const connection = withKey({ baseUrl, models: [model], timeoutMs: timeoutMs(input.openaiTimeoutMs, previous?.timeoutMs ?? deployment.timeoutMs) }, input.openaiApiKey, previous?.apiKey);
  const apiKey = assignmentConnectionKey(connection, deployment);
  if (!apiKey) throw httpError(400, '请填写当前 Base URL 对应的 OpenAI API Key');
  return { baseUrl, model, apiKey, timeoutMs: connection.timeoutMs };
}

function legacyModelFields(settings: ModelSettings, connection: SavedConnection | undefined) {
  return {
    aiAssignmentModel: settings.model,
    modelConfigRevision: settings.revision,
    aiAssignmentCustomModels: settings.connections.flatMap(item => item.models.filter(model => !presetIds.has(model))),
    openaiBaseUrl: connection?.baseUrl,
    openaiTimeoutMs: connection?.timeoutMs
  };
}

export function storedAssignmentModelSettings(settings: ModelSettings) {
  if (!settings.legacy) return { aiAssignmentModel: settings.model, modelConfigRevision: settings.revision, openaiModelConnections: settings.connections };
  const connection = settings.connections[0];
  return { ...legacyModelFields(settings, connection), ...(connection.apiKey ? { openaiApiKey: connection.apiKey } : {}) };
}

export function publicAssignmentModelSettings(settings: ModelSettings, deployment: DeploymentConnection) {
  const selected = assignmentConnectionFor(settings);
  const connections: PublicAssignmentModelConnection[] = settings.connections.map(connection => ({
    baseUrl: connection.baseUrl, models: connection.models, timeoutMs: connection.timeoutMs,
    apiKeySaved: Boolean(connection.apiKey), apiKeyConfigured: Boolean(assignmentConnectionKey(connection, deployment))
  }));
  return {
    ...legacyModelFields(settings, selected), openaiModelConnections: connections,
    openaiApiKeySaved: Boolean(selected?.apiKey), openaiApiKeyConfigured: Boolean(selected && assignmentConnectionKey(selected, deployment))
  };
}
