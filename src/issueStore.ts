export function normalizeIssueState(raw: any, userKey: any) {
  return {
    userKey: String(userKey || 'default'),
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    bugs: Array.isArray(raw?.bugs) ? raw.bugs : []
  };
}

