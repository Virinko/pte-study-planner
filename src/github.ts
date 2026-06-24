import type { StudyData } from './types';

interface GitHubConfig { owner: string; repo: string; branch: string; path: string; }
interface ContentResponse { content: string; encoding: string; sha: string; }
const apiUrl = (c: GitHubConfig) => `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(c.branch)}`;
const headers = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
const decode = (content: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0)))) as StudyData;
const encode = (data: StudyData) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data, null, 2))));

export async function fetchGitHubData(config: GitHubConfig, token: string) {
  const res = await fetch(apiUrl(config), { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub 读取失败：HTTP ${res.status}`);
  const json = (await res.json()) as ContentResponse;
  return { data: decode(json.content), sha: json.sha };
}

export async function saveGitHubData(config: GitHubConfig, token: string, data: StudyData) {
  const current = await fetchGitHubData(config, token);
  const res = await fetch(apiUrl(config).replace(/\?ref=.*/, ''), {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'update pte study data', content: encode(data), sha: current.sha, branch: config.branch }),
  });
  if (!res.ok) throw new Error(`GitHub 保存失败：HTTP ${res.status}`);
  return res.json();
}
