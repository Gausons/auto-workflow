export const DEFAULT_AI_ASSIGNMENT_MODEL = 'gpt-6-luna';

export const AI_ASSIGNMENT_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5', name: 'GPT-5.5' }
] as const;
