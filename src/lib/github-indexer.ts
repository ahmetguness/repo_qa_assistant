import { prisma } from "@/lib/prisma";
import {
  getGitHubRepo,
  getGitHubTree,
  getGitHubFileContent,
  getGitHubCommits,
  getGitHubPRs,
  getGitHubBranches,
} from "@/lib/github";

const MAX_FILE_SIZE = 500 * 1024;
const SYNC_COOLDOWN_MS = 60 * 60 * 1000;

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "cargo.lock", "go.sum", ".ds_store",
]);

const SKIP_PATHS = /node_modules|\.git\/|dist\/|build\/|__pycache__|\.next\/|\.min\.|\.map$/i;

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".rb",
  ".php", ".cs", ".cpp", ".c", ".h", ".swift", ".kt", ".scala",
  ".vue", ".svelte", ".html", ".css", ".scss", ".json", ".yaml", ".yml",
  ".toml", ".xml", ".graphql", ".sql", ".sh", ".md", ".mdx", ".txt",
  ".dockerfile", ".gitignore", ".env.example", ".prisma", ".proto", ".tf",
]);

function shouldIndex(path: string, size?: number): boolean {
  if (size && size > MAX_FILE_SIZE) return false;
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (SKIP_FILES.has(name)) return false;
  if (SKIP_PATHS.test(path)) return false;
  if (name.includes(".min.")) return false;
  const ext = "." + name.split(".").pop();
  if (["dockerfile", "makefile", "gemfile", "procfile"].includes(name)) return true;
  return CODE_EXTENSIONS.has(ext);
}

function detectLang(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", java: "Java", go: "Go", rs: "Rust", rb: "Ruby",
    php: "PHP", cs: "C#", cpp: "C++", c: "C", h: "C", swift: "Swift",
    html: "HTML", css: "CSS", scss: "SCSS", json: "JSON",
    yaml: "YAML", yml: "YAML", sql: "SQL", sh: "Shell", md: "Markdown",
    prisma: "Prisma", vue: "Vue", svelte: "Svelte",
  };
  return map[ext ?? ""] ?? null;
}

export async function syncGitHubRepo(owner: string, repoName: string) {
  const fullName = `${owner}/${repoName}`;

  // Check if already synced recently
  const existing = await prisma.repository.findFirst({
    where: { source: "github", fullName },
  });

  if (existing?.lastSyncedAt && Date.now() - existing.lastSyncedAt.getTime() < SYNC_COOLDOWN_MS) {
    return { repoId: existing.id, skipped: true };
  }

  // Fetch repo info
  const ghRepo = await getGitHubRepo(owner, repoName);

  // Upsert repository
  const repo = await prisma.repository.upsert({
    where: { source_fullName: { source: "github", fullName } },
    update: {
      name: ghRepo.name,
      description: ghRepo.description,
      language: ghRepo.language,
      isPrivate: ghRepo.private,
      defaultBranch: ghRepo.default_branch,
    },
    create: {
      slug: repoName,
      name: ghRepo.name,
      fullName,
      source: "github",
      description: ghRepo.description,
      language: ghRepo.language,
      isPrivate: ghRepo.private,
      defaultBranch: ghRepo.default_branch,
      workspaceId: null,
    },
  });

  // Fetch file tree (single API call for entire repo)
  const tree = await getGitHubTree(owner, repoName, ghRepo.default_branch);
  const indexableFiles = tree.filter((f) => shouldIndex(f.path, f.size));

  // Fetch and store file contents
  let indexed = 0;
  for (const file of indexableFiles) {
    try {
      const content = await getGitHubFileContent(owner, repoName, file.path, ghRepo.default_branch);
      await prisma.repoFile.upsert({
        where: { repositoryId_path: { repositoryId: repo.id, path: file.path } },
        update: { content, size: file.size ?? content.length, language: detectLang(file.path), lastSyncedAt: new Date() },
        create: {
          repositoryId: repo.id, path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          type: "file", size: file.size ?? content.length,
          content, language: detectLang(file.path),
        },
      });
      indexed++;
    } catch { /* skip */ }
  }

  // Commits
  const commits = await getGitHubCommits(owner, repoName, 30);
  for (const c of commits) {
    await prisma.repoCommit.upsert({
      where: { repositoryId_hash: { repositoryId: repo.id, hash: c.sha } },
      update: {},
      create: {
        repositoryId: repo.id, hash: c.sha,
        message: c.commit.message,
        authorName: c.commit.author.name,
        authorEmail: c.commit.author.email,
        date: new Date(c.commit.author.date),
      },
    });
  }

  // PRs
  try {
    const prs = await getGitHubPRs(owner, repoName, 15);
    for (const pr of prs) {
      await prisma.repoPullRequest.upsert({
        where: { repositoryId_prNumber: { repositoryId: repo.id, prNumber: pr.number } },
        update: { title: pr.title, description: pr.body, state: pr.state.toUpperCase(), filesChanged: pr.changed_files ?? 0, updatedDate: new Date(pr.updated_at) },
        create: {
          repositoryId: repo.id, prNumber: pr.number,
          title: pr.title, description: pr.body, state: pr.state.toUpperCase(),
          authorName: pr.user.login, sourceBranch: pr.head.ref, targetBranch: pr.base.ref,
          filesChanged: pr.changed_files ?? 0,
          createdDate: new Date(pr.created_at), updatedDate: new Date(pr.updated_at),
        },
      });
    }
  } catch { /* ignore */ }

  // Branches
  try {
    const branches = await getGitHubBranches(owner, repoName);
    for (const b of branches) {
      await prisma.repoBranch.upsert({
        where: { repositoryId_name: { repositoryId: repo.id, name: b.name } },
        update: { commitHash: b.commit.sha },
        create: { repositoryId: repo.id, name: b.name, commitHash: b.commit.sha },
      });
    }
  } catch { /* ignore */ }

  await prisma.repository.update({
    where: { id: repo.id },
    data: { lastSyncedAt: new Date() },
  });

  return { repoId: repo.id, skipped: false, filesIndexed: indexed, commits: commits.length };
}
