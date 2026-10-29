import './site.css';

// Preserve bookmarked hash routes from the original workbench homepage.
const legacy = location.hash.slice(1);
if (/^(?:tasks|new-task|inbox|devices|workbench|history(?:\/[a-f0-9]{64})?|settings(?:\/(?:assignment|config|account|members))?|members|assignment|config|account)$/.test(legacy)) {
  const destination = legacy === 'new-task' ? 'tasks/new' : legacy === 'settings' ? 'settings/assignment' : ['members', 'settings/members'].includes(legacy) ? 'settings/account' : ['assignment', 'config', 'account'].includes(legacy) ? `settings/${legacy}` : legacy;
  location.replace(`/${destination}`);
}
const theme = document.querySelector<HTMLButtonElement>('[data-theme]');
try { const saved = localStorage.getItem('agentflow.site.theme'); if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved; } catch { /* storage is optional */ }
theme?.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('agentflow.site.theme', next); } catch { /* storage is optional */ }
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) button.addEventListener('click', async () => {
  const text = button.parentElement?.nextElementSibling?.textContent || '';
  try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; }
  catch { button.textContent = '请手动复制'; }
  setTimeout(() => { button.textContent = '复制'; }, 2000);
});
const menu = document.querySelector<HTMLButtonElement>('.docs-menu');
menu?.addEventListener('click', () => { menu.setAttribute('aria-expanded', String(menu.getAttribute('aria-expanded') !== 'true')); });
interface SearchEntry { title: string; description: string; text: string; url: string }
const search = document.querySelector<HTMLInputElement>('#doc-search');
const results = document.querySelector<HTMLElement>('#search-results');
const index: SearchEntry[] = JSON.parse(document.querySelector('#search-index')?.textContent || '[]');
function updateSearch() {
  if (!search || !results) return;
  const query = search.value.trim().toLocaleLowerCase();
  results.replaceChildren();
  results.hidden = !query;
  if (!query) return;
  const matches = index.filter(entry => `${entry.title} ${entry.description} ${entry.text}`.toLocaleLowerCase().includes(query));
  const count = document.createElement('p'); count.textContent = matches.length ? `找到 ${matches.length} 篇文档` : '没有找到结果，试试“设备”或“部署”。'; results.append(count);
  for (const entry of matches) {
    const link = document.createElement('a'); link.href = entry.url;
    const title = document.createElement('strong'); title.textContent = entry.title;
    const description = document.createElement('small'); description.textContent = entry.description;
    link.append(title, description); results.append(link);
  }
}
search?.addEventListener('input', updateSearch);
search?.addEventListener('focus', updateSearch);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && results) { results.hidden = true; search?.blur(); }
  if (event.key === '/' && search && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); search.focus(); }
});
document.addEventListener('click', event => { if (results && event.target instanceof Node && !results.contains(event.target) && event.target !== search) results.hidden = true; });
