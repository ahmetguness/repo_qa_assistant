const BITBUCKET_API = "https://api.bitbucket.org/2.0";

interface BitbucketPaginated<T> {
  values: T[];
  next?: string;
  page?: number;
  size?: number;
}

export interface BitbucketWorkspace {
  uuid: string;
  slug: string;
  name: string;
  links: { avatar: { href: string } };
}

export interface BitbucketRepo {
  uuid: string;
  slug: string;
  name: string;
  full_name: string;
  description: string;
  language: string;
  is_private: boolean;
  mainbranch?: { name: string };
}

export interface BitbucketFileEntry {
  path: string;
  type: "commit_file" | "commit_directory";
  size?: number;
}

export interface BitbucketCommit {
  hash: string;
  message: string;
  date: string;
  author: {
    raw: string;
    user?: { display_name: string };
  };
}

export interface BitbucketPullRequest {
  id: number;
  title: string;
  description: string;
  state: string;
  author: { display_name: string };
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  created_on: string;
  updated_on: string;
}

export interface BitbucketBranch {
  name: string;
  target: {
    hash: string;
    date: string;
  };
}

export interface BitbucketDiffStat {
  status: string;
  old?: { path: string };
  new?: { path: string };
  lines_added: number;
  lines_removed: number;
}

export interface BitbucketCommitFile {
  path: string;
  type: string;
}

async function fetchBitbucket<T>(
  path: string,
  accessToken: string
): Promise<T> {
  const res = await fetch(`${BITBUCKET_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bitbucket API error ${res.status}: ${text}`);
  }

  return res.json();
}

async function fetchAllPages<T>(
  path: string,
  accessToken: string,
  maxPages = 10
): Promise<T[]> {
  const items: T[] = [];
  let url: string | undefined = `${BITBUCKET_API}${path}`;
  let page = 0;

  while (url && page < maxPages) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) break;

    const data: BitbucketPaginated<T> = await res.json();
    items.push(...data.values);
    url = data.next;
    page++;
  }

  return items;
}

// ─── Internal types for new API ─────────────────────

// Resolve branch name to a commit hash (needed for branches with / in name)
// Cache resolved refs to avoid repeated API calls
const branchRefCache = new Map<string, { hash: string; ts: number }>();

async function resolveBranchRef(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  branch: string
): Promise<string> {
  if (/^[0-9a-f]{12,40}$/.test(branch)) return branch;
  if (!branch.includes("/")) return branch;

  const cacheKey = `${workspace}/${repoSlug}/${branch}`;
  const cached = branchRefCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.hash;

  const encoded = encodeURIComponent(branch);
  const data = await fetchBitbucket<{ target: { hash: string } }>(
    `/repositories/${workspace}/${repoSlug}/refs/branches/${encoded}`,
    accessToken
  );
  branchRefCache.set(cacheKey, { hash: data.target.hash, ts: Date.now() });
  return data.target.hash;
}

interface BitbucketWorkspaceAccess {
  type: "workspace_access";
  workspace: {
    type: string;
    uuid: string;
    slug: string;
    links: {
      avatar: { href: string };
      self: { href: string };
    };
  };
}

// ─── Public API ─────────────────────────────────────

export async function getWorkspaces(
  accessToken: string
): Promise<BitbucketWorkspace[]> {
  // CHANGE-2770: /workspaces is deprecated (410 Gone since April 2026)
  // /user/workspaces returns workspace_access objects with nested workspace
  const accesses = await fetchAllPages<BitbucketWorkspaceAccess>(
    "/user/workspaces?pagelen=100",
    accessToken
  );

  return accesses.map((a) => ({
    uuid: a.workspace.uuid,
    slug: a.workspace.slug,
    name: a.workspace.slug,
    links: { avatar: a.workspace.links.avatar },
  }));
}

export async function getWorkspaceDetail(
  accessToken: string,
  slug: string
): Promise<BitbucketWorkspace> {
  return fetchBitbucket<BitbucketWorkspace>(
    `/workspaces/${slug}`,
    accessToken
  );
}

export async function getRepositories(
  accessToken: string,
  workspace: string
): Promise<BitbucketRepo[]> {
  return fetchAllPages<BitbucketRepo>(
    `/repositories/${workspace}?pagelen=100&sort=-updated_on`,
    accessToken
  );
}

export async function getRepoTree(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  branch: string,
  path = ""
): Promise<BitbucketFileEntry[]> {
  const ref = await resolveBranchRef(accessToken, workspace, repoSlug, branch);
  const encodedPath = path ? `/${encodeURIComponent(path)}` : "";
  return fetchAllPages<BitbucketFileEntry>(
    `/repositories/${workspace}/${repoSlug}/src/${ref}/${encodedPath}?pagelen=100`,
    accessToken,
    20
  );
}

export async function getFileContent(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  branch: string,
  filePath: string
): Promise<string> {
  const ref = await resolveBranchRef(accessToken, workspace, repoSlug, branch);
  const res = await fetch(
    `${BITBUCKET_API}/repositories/${workspace}/${repoSlug}/src/${ref}/${encodeURIComponent(filePath)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch file: ${res.status}`);
  }

  return res.text();
}

export async function getCommits(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  limit = 50
): Promise<BitbucketCommit[]> {
  return fetchAllPages<BitbucketCommit>(
    `/repositories/${workspace}/${repoSlug}/commits?pagelen=${Math.min(limit, 100)}`,
    accessToken,
    Math.ceil(limit / 100)
  );
}

export async function getPullRequests(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  state = ""
): Promise<BitbucketPullRequest[]> {
  const stateParam = state ? `&state=${state}` : "";
  return fetchAllPages<BitbucketPullRequest>(
    `/repositories/${workspace}/${repoSlug}/pullrequests?pagelen=50${stateParam}`,
    accessToken,
    5
  );
}

export async function getBranches(
  accessToken: string,
  workspace: string,
  repoSlug: string
): Promise<BitbucketBranch[]> {
  return fetchAllPages<BitbucketBranch>(
    `/repositories/${workspace}/${repoSlug}/refs/branches?pagelen=100`,
    accessToken,
    3
  );
}

export async function getPRDiffStat(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  prId: number
): Promise<BitbucketDiffStat[]> {
  return fetchAllPages<BitbucketDiffStat>(
    `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/diffstat?pagelen=100`,
    accessToken,
    3
  );
}

export async function getCommitDiffStat(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  commitHash: string
): Promise<BitbucketDiffStat[]> {
  return fetchAllPages<BitbucketDiffStat>(
    `/repositories/${workspace}/${repoSlug}/diffstat/${commitHash}?pagelen=100`,
    accessToken,
    2
  );
}
