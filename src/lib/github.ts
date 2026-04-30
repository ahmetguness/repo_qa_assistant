const GITHUB_API = "https://api.github.com";

const headers: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "RepoQA-Assistant",
};

// Add token if available (raises rate limit from 60 to 5000/hour)
if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function fetchGitHub<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Types ──────────────────────────────────────────

interface GitHubRepo {
  full_name: string;
  name: string;
  description: string | null;
  language: string | null;
  private: boolean;
  default_branch: string;
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  files?: { filename: string }[];
}

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  changed_files?: number;
  created_at: string;
  updated_at: string;
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

// ─── Public API ─────────────────────────────────────

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  // Match: https://github.com/owner/repo, github.com/owner/repo, owner/repo
  const patterns = [
    /github\.com\/([^/]+)\/([^/\s?#]+)/,
    /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/,
  ];
  for (const p of patterns) {
    const m = url.trim().match(p);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }
  return null;
}

export async function getGitHubRepo(owner: string, repo: string): Promise<GitHubRepo> {
  return fetchGitHub<GitHubRepo>(`/repos/${owner}/${repo}`);
}

export async function getGitHubTree(owner: string, repo: string, branch: string): Promise<GitHubTreeEntry[]> {
  const data = await fetchGitHub<{ tree: GitHubTreeEntry[]; truncated: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
  );
  return data.tree.filter((e) => e.type === "blob"); // Only files
}

export async function getGitHubFileContent(owner: string, repo: string, path: string, branch: string): Promise<string> {
  // Use raw content endpoint — no base64 decoding needed
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
    { headers: { "User-Agent": "RepoQA-Assistant" } }
  );
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.text();
}

export async function getGitHubCommits(owner: string, repo: string, count = 30): Promise<GitHubCommit[]> {
  return fetchGitHub<GitHubCommit[]>(`/repos/${owner}/${repo}/commits?per_page=${count}`);
}

export async function getGitHubPRs(owner: string, repo: string, count = 20): Promise<GitHubPR[]> {
  return fetchGitHub<GitHubPR[]>(`/repos/${owner}/${repo}/pulls?state=all&per_page=${count}&sort=updated&direction=desc`);
}

export async function getGitHubBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
  return fetchGitHub<GitHubBranch[]>(`/repos/${owner}/${repo}/branches?per_page=100`);
}
