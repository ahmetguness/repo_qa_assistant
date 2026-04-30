import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("sk-buraya")) {
    return NextResponse.json({
      reply: "⚠️ OpenAI API anahtarı henüz ayarlanmamış. .env dosyasına geçerli bir OPENAI_API_KEY yazın.",
    });
  }

  const { messages, workspaceSlug, repoSlug } = await request.json();

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "Messages required" }, { status: 400 });
  }

  try {
    // Read from DB only — no Bitbucket API calls here
    // Sync happens via /api/workspaces, /api/repos, /api/repos/sync

    // Get workspace/repo list from DB
    const userWorkspaces = await prisma.workspace.findMany({
      where: { users: { some: { userId: session.user.id } } },
      include: {
        repositories: {
          select: { slug: true, name: true, description: true, language: true },
          orderBy: { name: "asc" },
        },
      },
    });

    const workspaceContext = buildWorkspaceContext(userWorkspaces);

    // Build repo context if selected
    let repoContext = "";

    if (workspaceSlug && repoSlug) {
      repoContext = await buildRepoContext(workspaceSlug, repoSlug);
    } else {
      // Auto-detect repo from message
      const lastUserMsg = messages.filter((m: { role: string }) => m.role === "user").pop();
      if (lastUserMsg) {
        const detected = detectRepoFromMessage(lastUserMsg.content, userWorkspaces);
        if (detected) {
          repoContext = await buildRepoContext(detected.workspace, detected.repo);
        }
      }
    }

    const systemPrompt = buildSystemPrompt(workspaceContext, repoContext, workspaceSlug, repoSlug);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ],
      max_tokens: 4096,
      temperature: 0.3,
    });

    const reply = completion.choices[0]?.message?.content ?? "Yanıt alınamadı.";

    return NextResponse.json({ reply });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Bilinmeyen hata";
    console.error("Chat API error:", message);
    return NextResponse.json({ error: "AI yanıt üretemedi: " + message }, { status: 500 });
  }
}

// ─── Detect repo name from user message ─────────────

interface WorkspaceWithRepos {
  slug: string;
  name: string;
  repositories: { slug: string; name: string }[];
}

function detectRepoFromMessage(
  message: string,
  workspaces: WorkspaceWithRepos[]
): { workspace: string; repo: string } | null {
  const lowerMsg = message.toLowerCase();
  for (const ws of workspaces) {
    for (const repo of ws.repositories) {
      if (
        lowerMsg.includes(repo.slug.toLowerCase()) ||
        lowerMsg.includes(repo.name.toLowerCase())
      ) {
        return { workspace: ws.slug, repo: repo.slug };
      }
    }
  }
  return null;
}

// ─── Build context strings ──────────────────────────

function buildWorkspaceContext(workspaces: WorkspaceWithRepos[]): string {
  if (workspaces.length === 0) return "";

  const parts: string[] = ["## Erişilebilir Workspace ve Repolar\n"];
  for (const ws of workspaces) {
    parts.push(`### Workspace: ${ws.name} (${ws.slug})`);
    if (ws.repositories.length === 0) {
      parts.push("- Henüz repo bulunamadı\n");
    } else {
      for (const repo of ws.repositories) {
        const desc = (repo as { description?: string }).description;
        const lang = (repo as { language?: string }).language;
        parts.push(
          `- **${repo.name}** (\`${repo.slug}\`)${lang ? ` [${lang}]` : ""}${desc ? ` — ${desc}` : ""}`
        );
      }
      parts.push("");
    }
  }
  return parts.join("\n");
}

function buildSystemPrompt(
  workspaceContext: string,
  repoContext: string,
  workspace?: string,
  repo?: string
): string {
  const base = `Sen bir şirket içi kıdemli yazılım mühendisi ve kod analiz uzmanısın. Bitbucket repolarını derinlemesine analiz edip, teknik ve teknik olmayan kişilerin anlayabileceği şekilde açıklıyorsun.

## Temel Kurallar
- Her zaman Türkçe yanıt ver.
- Markdown formatı kullan (başlıklar, listeler, kod blokları, tablolar).
- Repo isimlerini her zaman **kalın** (bold) yaz.
- Emin olmadığın bilgileri uydurma, "Bu bilgiye erişimim yok" de.

## Kod Analiz Kuralları
- Bir dosya sorulduğunda: dosyanın amacını, içindeki fonksiyonları/sınıfları, bağımlılıklarını ve diğer dosyalarla ilişkisini açıkla.
- Bir proje sorulduğunda: mimariyi, kullanılan teknolojileri, klasör yapısının mantığını, veritabanı şemasını, API endpoint'lerini detaylı açıkla.
- Kod bloklarını gösterirken hangi dosyadan geldiğini belirt.
- Teknik terimleri kullandığında parantez içinde kısa Türkçe açıklama ekle. Örnek: "ORM (Nesne-İlişkisel Eşleme)"
- Dosyalar arası bağımlılıkları ve veri akışını açıkla.
- Güvenlik açıkları veya potansiyel sorunlar görürsen belirt.

## Detaylı Rapor İstendiğinde
Kullanıcı "detaylı rapor", "analiz et", "açıkla" gibi ifadeler kullandığında şu yapıda yanıt ver:

1. **Proje Özeti**: Projenin amacı, hedef kitlesi, ne problemi çözdüğü
2. **Teknoloji Yığını**: Frontend, backend, veritabanı, üçüncü parti servisler
3. **Mimari**: Monolitik mi, mikroservis mi, klasör yapısı neden böyle organize edilmiş
4. **Veritabanı Şeması**: Tablolar, ilişkiler, önemli alanlar (schema.prisma, migration dosyalarından)
5. **API Yapısı**: Endpoint'ler, route'lar, middleware'ler
6. **İş Mantığı**: Temel iş akışları, servisler, önemli fonksiyonlar
7. **Konfigürasyon**: Environment değişkenleri, Docker yapısı, CI/CD
8. **Bağımlılıklar**: Önemli paketler ve ne için kullanıldıkları
9. **Geliştirme Durumu**: Son commit'ler, aktif branch'ler, açık PR'lar

## Commit ve PR Analizi
- Commit mesajlarından geliştirme sürecini ve öncelikleri çıkar.
- PR'lardan code review sürecini ve ekip çalışma şeklini analiz et.
- Branch isimlendirme konvansiyonunu tespit et (feature/, bugfix/, hotfix/ vb.)`;

  let context = base + "\n\n";

  if (workspaceContext) {
    context += workspaceContext + "\n\n";
  }

  if (repoContext) {
    context += `Şu anda "${workspace}/${repo}" reposu detaylı olarak analiz edilmiş:\n\n${repoContext}`;
  } else if (workspace && repo) {
    context += `"${workspace}/${repo}" reposu seçili ama henüz indekslenmemiş. Kullanıcıya sağ üstteki repo seçiciden tekrar seçmesini veya biraz beklemesini söyle.`;
  } else {
    context += "Henüz belirli bir repo seçili değil. Kullanıcı sağ üstteki dropdown'dan repo seçebilir veya chat'te repo adını yazabilir.";
  }

  return context;
}

async function buildRepoContext(
  workspaceSlug: string,
  repoSlug: string
): Promise<string> {
  const repo = await prisma.repository.findFirst({
    where: {
      slug: repoSlug,
      workspace: { slug: workspaceSlug },
    },
    include: {
      files: {
        select: { path: true, language: true, size: true, content: true },
        orderBy: { path: "asc" },
      },
      commits: {
        select: { hash: true, message: true, authorName: true, date: true, filesChanged: true },
        orderBy: { date: "desc" },
        take: 30,
      },
      pullRequests: {
        select: {
          prNumber: true,
          title: true,
          description: true,
          state: true,
          authorName: true,
          sourceBranch: true,
          targetBranch: true,
          filesChanged: true,
        },
        orderBy: { updatedDate: "desc" },
        take: 20,
      },
      branches: {
        select: { name: true, commitHash: true },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!repo) return "";

  const parts: string[] = [];

  // ─── Repo overview
  parts.push(`## Repo: ${repo.fullName}`);
  parts.push(`Açıklama: ${repo.description ?? "Yok"}`);
  parts.push(`Dil: ${repo.language ?? "Belirtilmemiş"}`);
  parts.push(`Varsayılan branch: ${repo.defaultBranch}`);
  parts.push(`Toplam dosya: ${repo.files.length}`);

  const langStats: Record<string, number> = {};
  for (const f of repo.files) {
    const lang = f.language ?? "Diğer";
    langStats[lang] = (langStats[lang] ?? 0) + 1;
  }
  const langSummary = Object.entries(langStats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l, c]) => `${l}: ${c}`)
    .join(", ");
  parts.push(`Dil dağılımı: ${langSummary}`);
  parts.push("");

  // ─── Branches
  if (repo.branches.length > 0) {
    parts.push("## Branch'ler");
    for (const b of repo.branches) {
      const isDefault = b.name === repo.defaultBranch ? " ⭐ (varsayılan)" : "";
      parts.push(`- ${b.name}${isDefault}`);
    }
    parts.push("");
  }

  // ─── File tree
  parts.push("## Dosya Yapısı");
  parts.push(buildFileTree(repo.files.map((f) => f.path)));
  parts.push("");

  // ─── Priority file contents
  const PRIORITY_FILES = new Set(["readme.md", "readme.txt", "readme", "readme.rst"]);
  const CONFIG_FILES = new Set([
    "package.json", "requirements.txt", "pyproject.toml", "cargo.toml",
    "go.mod", "pom.xml", "build.gradle", "gemfile", "composer.json",
    "dockerfile", "docker-compose.yml", "docker-compose.yaml",
    ".env.example", "tsconfig.json", "next.config.ts", "next.config.js",
    "next.config.mjs", "vite.config.ts", "webpack.config.js",
    "bitbucket-pipelines.yml", ".gitlab-ci.yml", "makefile",
    "prisma/schema.prisma",
  ]);

  const priorityFiles: typeof repo.files = [];
  const configFiles: typeof repo.files = [];
  const otherFiles: typeof repo.files = [];

  for (const file of repo.files) {
    const name = file.path.toLowerCase().split("/").pop() ?? "";
    const pathLower = file.path.toLowerCase();
    if (PRIORITY_FILES.has(name)) priorityFiles.push(file);
    else if (CONFIG_FILES.has(name) || CONFIG_FILES.has(pathLower)) configFiles.push(file);
    else otherFiles.push(file);
  }

  parts.push("## Dosya İçerikleri");

  let totalChars = 0;
  const MAX_CONTEXT_CHARS = 100000;

  for (const file of priorityFiles) {
    if (!file.content) continue;
    const content = file.content.length > 10000 ? file.content.slice(0, 10000) + "\n... (kırpıldı)" : file.content;
    parts.push(`\n### 📄 ${file.path} (README)`);
    parts.push("```" + (file.language?.toLowerCase() ?? ""));
    parts.push(content);
    parts.push("```");
    totalChars += content.length;
  }

  for (const file of configFiles) {
    if (!file.content || totalChars > MAX_CONTEXT_CHARS) continue;
    const content = file.content.length > 5000 ? file.content.slice(0, 5000) + "\n... (kırpıldı)" : file.content;
    parts.push(`\n### ⚙️ ${file.path}`);
    parts.push("```" + (file.language?.toLowerCase() ?? ""));
    parts.push(content);
    parts.push("```");
    totalChars += content.length;
  }

  for (const file of otherFiles) {
    if (!file.content) continue;
    if (totalChars > MAX_CONTEXT_CHARS) {
      parts.push(`\n... (${otherFiles.length - otherFiles.indexOf(file)} dosya daha, bağlam limiti aşıldı)`);
      break;
    }
    const content = file.content.length > 5000 ? file.content.slice(0, 5000) + "\n... (kırpıldı)" : file.content;
    parts.push(`\n### ${file.path}`);
    parts.push("```" + (file.language?.toLowerCase() ?? ""));
    parts.push(content);
    parts.push("```");
    totalChars += content.length;
  }
  parts.push("");

  // ─── Commits
  if (repo.commits.length > 0) {
    parts.push("## Son Commit'ler");
    for (const c of repo.commits) {
      const date = c.date.toISOString().split("T")[0];
      const files = c.filesChanged
        ? ` | Değişen: ${c.filesChanged.split(",").slice(0, 5).join(", ")}${c.filesChanged.split(",").length > 5 ? "..." : ""}`
        : "";
      parts.push(`- [${c.hash.slice(0, 7)}] ${date} - ${c.authorName}: ${c.message.split("\n")[0]}${files}`);
    }
    parts.push("");
  }

  // ─── PRs
  if (repo.pullRequests.length > 0) {
    parts.push("## Pull Request'ler");
    for (const pr of repo.pullRequests) {
      parts.push(
        `- PR #${pr.prNumber} [${pr.state}] "${pr.title}" (${pr.authorName}, ${pr.sourceBranch} → ${pr.targetBranch}, ${pr.filesChanged} dosya)`
      );
      if (pr.description) {
        parts.push(`  Açıklama: ${pr.description.slice(0, 300)}`);
      }
    }
  }

  return parts.join("\n");
}

// ─── Build tree structure from file paths

function buildFileTree(paths: string[]): string {
  interface TreeNode { children: Map<string, TreeNode>; }
  const root: TreeNode = { children: new Map() };

  for (const p of paths) {
    const segments = p.split("/");
    let current = root;
    for (const seg of segments) {
      if (!current.children.has(seg)) current.children.set(seg, { children: new Map() });
      current = current.children.get(seg)!;
    }
  }

  function render(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): string[] {
    const lines: string[] = [];
    const entries = Array.from(node.children.entries()).sort(([a], [b]) => {
      const aIsDir = node.children.get(a)!.children.size > 0;
      const bIsDir = node.children.get(b)!.children.size > 0;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < entries.length; i++) {
      const [name, child] = entries[i];
      const last = i === entries.length - 1;
      const connector = isRoot ? "" : (last ? "└── " : "├── ");
      const newPrefix = isRoot ? "" : prefix + (last ? "    " : "│   ");
      const isDir = child.children.size > 0;
      lines.push(`${isRoot ? "" : prefix}${connector}${isDir ? "📁 " : ""}${name}`);
      if (isDir) lines.push(...render(child, newPrefix, last, false));
    }
    return lines;
  }

  return render(root, "", false, true).join("\n");
}
