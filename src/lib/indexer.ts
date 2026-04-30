import { prisma } from "@/lib/prisma";
import {
  getRepositories,
  getRepoTree,
  getFileContent,
  getCommits,
  getPullRequests,
  getWorkspaces,
  getWorkspaceDetail,
  getBranches,
  getPRDiffStat,
  getCommitDiffStat,
} from "@/lib/bitbucket";

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const SYNC_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".rb",
  ".php", ".cs", ".cpp", ".c", ".h", ".swift", ".kt", ".scala",
  ".vue", ".svelte", ".html", ".css", ".scss", ".less", ".sass",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".graphql", ".gql",
  ".sql", ".sh", ".bash", ".zsh", ".ps1", ".bat",
  ".md", ".mdx", ".txt", ".rst",
  ".dockerfile", ".dockerignore", ".gitignore", ".env.example",
  ".prisma", ".proto", ".tf", ".hcl",
]);

function shouldIndexFile(path: string, size?: number): boolean {
  if (size && size > MAX_FILE_SIZE) return false;
  const ext = "." + path.split(".").pop()?.toLowerCase();
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  // Include known config files without extensions
  if (["dockerfile", "makefile", "rakefile", "gemfile", "procfile"].includes(name)) {
    return true;
  }
  return CODE_EXTENSIONS.has(ext);
}

function detectLanguage(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", java: "Java", go: "Go", rs: "Rust", rb: "Ruby",
    php: "PHP", cs: "C#", cpp: "C++", c: "C", h: "C", swift: "Swift",
    kt: "Kotlin", scala: "Scala", vue: "Vue", svelte: "Svelte",
    html: "HTML", css: "CSS", scss: "SCSS", json: "JSON",
    yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML",
    sql: "SQL", sh: "Shell", md: "Markdown", mdx: "MDX",
    prisma: "Prisma", proto: "Protobuf", tf: "Terraform",
    graphql: "GraphQL", gql: "GraphQL",
  };
  return map[ext ?? ""] ?? null;
}

// ─── Sync Workspaces ────────────────────────────────

export async function syncWorkspaces(accessToken: string, userId: string) {
  const workspaces = await getWorkspaces(accessToken);

  for (const ws of workspaces) {
    // Fetch full workspace detail to get the real name
    let name = ws.name;
    let avatarUrl = ws.links?.avatar?.href;
    try {
      const detail = await getWorkspaceDetail(accessToken, ws.slug);
      name = detail.name || ws.slug;
      avatarUrl = detail.links?.avatar?.href || avatarUrl;
    } catch {
      // fallback to slug as name
    }

    const workspace = await prisma.workspace.upsert({
      where: { slug: ws.slug },
      update: { name, avatarUrl },
      create: {
        slug: ws.slug,
        name,
        avatarUrl,
      },
    });

    await prisma.userWorkspace.upsert({
      where: {
        userId_workspaceId: { userId, workspaceId: workspace.id },
      },
      update: {},
      create: { userId, workspaceId: workspace.id },
    });
  }
}

// ─── Sync Repositories List ─────────────────────────

export async function syncRepositories(
  accessToken: string,
  workspaceSlug: string
) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
  });
  if (!workspace) throw new Error("Workspace not found");

  const repos = await getRepositories(accessToken, workspaceSlug);

  for (const repo of repos) {
    await prisma.repository.upsert({
      where: {
        workspaceId_slug: { workspaceId: workspace.id, slug: repo.slug },
      },
      update: {
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || null,
        language: repo.language || null,
        isPrivate: repo.is_private,
        defaultBranch: repo.mainbranch?.name ?? "main",
      },
      create: {
        slug: repo.slug,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || null,
        language: repo.language || null,
        isPrivate: repo.is_private,
        defaultBranch: repo.mainbranch?.name ?? "main",
        workspaceId: workspace.id,
      },
    });
  }

  return repos;
}

// ─── Sync Single Repo Content ───────────────────────

export async function syncRepoContent(
  accessToken: string,
  workspaceSlug: string,
  repoSlug: string
) {
  const repo = await prisma.repository.findFirst({
    where: {
      slug: repoSlug,
      workspace: { slug: workspaceSlug },
    },
  });

  if (!repo) throw new Error("Repository not found");

  // Check cooldown
  if (
    repo.lastSyncedAt &&
    Date.now() - repo.lastSyncedAt.getTime() < SYNC_COOLDOWN_MS
  ) {
    return { skipped: true, reason: "Recently synced" };
  }

  // 1. Sync file tree
  const tree = await getRepoTree(
    accessToken,
    workspaceSlug,
    repoSlug,
    repo.defaultBranch
  );

  // Recursively get files from subdirectories
  const allFiles = await collectFiles(
    accessToken,
    workspaceSlug,
    repoSlug,
    repo.defaultBranch,
    tree
  );

  // 2. Fetch and store file contents
  let indexed = 0;
  for (const file of allFiles) {
    if (!shouldIndexFile(file.path, file.size)) continue;

    try {
      const content = await getFileContent(
        accessToken,
        workspaceSlug,
        repoSlug,
        repo.defaultBranch,
        file.path
      );

      await prisma.repoFile.upsert({
        where: {
          repositoryId_path: { repositoryId: repo.id, path: file.path },
        },
        update: {
          content,
          size: file.size ?? content.length,
          language: detectLanguage(file.path),
          lastSyncedAt: new Date(),
        },
        create: {
          repositoryId: repo.id,
          path: file.path,
          name: file.path.split("/").pop() ?? file.path,
          type: "file",
          size: file.size ?? content.length,
          content,
          language: detectLanguage(file.path),
        },
      });
      indexed++;
    } catch {
      // Skip files that can't be fetched
    }
  }

  // 3. Sync commits (with changed files for recent ones)
  const commits = await getCommits(accessToken, workspaceSlug, repoSlug, 50);
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    let filesChanged: string | null = null;

    // Fetch changed files for the 10 most recent commits
    if (i < 10) {
      try {
        const diffstat = await getCommitDiffStat(
          accessToken, workspaceSlug, repoSlug, commit.hash
        );
        filesChanged = diffstat
          .map((d) => d.new?.path ?? d.old?.path ?? "?")
          .join(",");
      } catch {
        // ignore
      }
    }

    await prisma.repoCommit.upsert({
      where: {
        repositoryId_hash: { repositoryId: repo.id, hash: commit.hash },
      },
      update: { filesChanged },
      create: {
        repositoryId: repo.id,
        hash: commit.hash,
        message: commit.message,
        authorName:
          commit.author.user?.display_name ??
          commit.author.raw.split("<")[0].trim(),
        authorEmail: commit.author.raw.match(/<(.+)>/)?.[1] ?? null,
        filesChanged,
        date: new Date(commit.date),
      },
    });
  }

  // 4. Sync pull requests (with file count)
  const prs = await getPullRequests(accessToken, workspaceSlug, repoSlug);
  for (const pr of prs) {
    let filesChangedCount = 0;
    try {
      const diffstat = await getPRDiffStat(
        accessToken, workspaceSlug, repoSlug, pr.id
      );
      filesChangedCount = diffstat.length;
    } catch {
      // ignore
    }

    await prisma.repoPullRequest.upsert({
      where: {
        repositoryId_prNumber: { repositoryId: repo.id, prNumber: pr.id },
      },
      update: {
        title: pr.title,
        description: pr.description || null,
        state: pr.state,
        filesChanged: filesChangedCount,
        updatedDate: new Date(pr.updated_on),
      },
      create: {
        repositoryId: repo.id,
        prNumber: pr.id,
        title: pr.title,
        description: pr.description || null,
        state: pr.state,
        authorName: pr.author.display_name,
        sourceBranch: pr.source.branch.name,
        targetBranch: pr.destination.branch.name,
        filesChanged: filesChangedCount,
        createdDate: new Date(pr.created_on),
        updatedDate: new Date(pr.updated_on),
      },
    });
  }

  // 5. Sync branches
  try {
    const branches = await getBranches(accessToken, workspaceSlug, repoSlug);
    for (const branch of branches) {
      await prisma.repoBranch.upsert({
        where: {
          repositoryId_name: { repositoryId: repo.id, name: branch.name },
        },
        update: { commitHash: branch.target.hash },
        create: {
          repositoryId: repo.id,
          name: branch.name,
          commitHash: branch.target.hash,
        },
      });
    }
  } catch {
    // ignore branch sync errors
  }

  // Update last synced
  await prisma.repository.update({
    where: { id: repo.id },
    data: { lastSyncedAt: new Date() },
  });

  return { skipped: false, filesIndexed: indexed, commits: commits.length, prs: prs.length };
}

// ─── Helpers ────────────────────────────────────────

async function collectFiles(
  accessToken: string,
  workspace: string,
  repoSlug: string,
  branch: string,
  entries: { path: string; type: string; size?: number }[],
  depth = 0
): Promise<{ path: string; size?: number }[]> {
  if (depth > 5) return []; // Max recursion depth

  const files: { path: string; size?: number }[] = [];

  for (const entry of entries) {
    if (entry.type === "commit_file") {
      files.push({ path: entry.path, size: entry.size });
    } else if (entry.type === "commit_directory") {
      try {
        const subEntries = await getRepoTree(
          accessToken,
          workspace,
          repoSlug,
          branch,
          entry.path
        );
        const subFiles = await collectFiles(
          accessToken,
          workspace,
          repoSlug,
          branch,
          subEntries,
          depth + 1
        );
        files.push(...subFiles);
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  return files;
}
