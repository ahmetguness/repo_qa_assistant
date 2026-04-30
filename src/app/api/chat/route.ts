import { NextRequest } from "next/server";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY_MESSAGES = 8;

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  // Rate limiting
  const rl = checkRateLimit(session.user.id, "/api/chat");
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: `⏳ Çok fazla istek. ${Math.ceil(rl.resetIn / 1000)} saniye bekleyin.` }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(rl.resetIn / 1000)) } }
    );
  }

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("sk-buraya")) {
    return new Response(JSON.stringify({ error: "⚠️ OpenAI API anahtarı henüz ayarlanmamış." }), { headers: { "Content-Type": "application/json" } });
  }

  const { messages, workspaceSlug, repoSlug, sessionId, stream: wantStream, githubRepo } = await request.json();
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "Messages required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // Input validation
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.content && lastMsg.content.length > 10000) {
    return new Response(JSON.stringify({ error: "Mesaj çok uzun (max 10.000 karakter)" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  try {
    // Save user message to DB
    const userQuery = messages.filter((m: { role: string }) => m.role === "user").pop()?.content ?? "";
    if (sessionId && userQuery) {
      await prisma.chatMessage.create({ data: { chatSessionId: sessionId, role: "user", content: userQuery } });
      const msgCount = await prisma.chatMessage.count({ where: { chatSessionId: sessionId, role: "user" } });
      if (msgCount === 1) {
        await prisma.chatSession.update({
          where: { id: sessionId },
          data: { title: userQuery.length > 40 ? userQuery.slice(0, 40) + "…" : userQuery },
        });
      }
    }

    // Get workspace/repo list
    const userWorkspaces = await prisma.workspace.findMany({
      where: { users: { some: { userId: session.user.id } } },
      include: { repositories: { select: { slug: true, name: true, description: true, language: true }, orderBy: { name: "asc" } } },
    });

    // Build context
    let effectiveWs = workspaceSlug;
    let effectiveRepo = repoSlug;
    let fuzzyHint = "";

    if (!effectiveWs || !effectiveRepo) {
      // Check if user is confirming a previous repo suggestion
      const isConfirmation = /^(evet|yes|doğru|tamam|ok|onay|onu|aynen|kesinlikle|tabii|onu istiyorum|o repo)/i.test(userQuery.trim());
      const prevMessages = messages.filter((m: { role: string }) => m.role === "assistant");
      const lastAiMsg = prevMessages[prevMessages.length - 1]?.content ?? "";

      if (isConfirmation && lastAiMsg) {
        // User confirmed — find the repo mentioned in previous AI message
        const allRepos: { ws: string; slug: string; name: string }[] = [];
        for (const ws of userWorkspaces)
          for (const r of ws.repositories)
            allRepos.push({ ws: ws.slug, slug: r.slug, name: r.name });

        for (const r of allRepos) {
          if (lastAiMsg.includes(r.name) || lastAiMsg.includes(r.slug)) {
            effectiveWs = r.ws;
            effectiveRepo = r.slug;
            break;
          }
        }
      }

      // If still no repo, try to detect from message
      if (!effectiveWs || !effectiveRepo) {
        const detected = detectRepoFromMessage(userQuery, userWorkspaces);
        if (detected) {
          // Always ask for confirmation first — don't auto-select
          fuzzyHint = `\n\n⚠️ ONAY GEREKLİ: Kullanıcının mesajında bir repo tespit edildi: "${detected.name}" (\`${detected.workspace}/${detected.repo}\`). Henüz analiz yapma! Önce kullanıcıya şunu sor: "**${detected.name}** reposunu mu kastediyorsunuz? Onaylarsanız analiz başlayacak." Repo adını **kalın** yaz. Sadece onay iste, başka bir şey yapma.`;
        }
      }
    }

    let repoContext = "";
    if (githubRepo) {
      repoContext = await buildRepoContextById(githubRepo, userQuery);
    } else if (effectiveWs && effectiveRepo) {
      repoContext = await buildRepoContext(effectiveWs, effectiveRepo, userQuery);
    }

    const repoLabel = githubRepo ?? (effectiveWs && effectiveRepo ? `${effectiveWs}/${effectiveRepo}` : undefined);
    const systemPrompt = buildSystemPrompt(
      buildWorkspaceContext(userWorkspaces), repoContext, effectiveWs, effectiveRepo, repoLabel
    ) + fuzzyHint;

    // Trim conversation history to save tokens
    const trimmedMessages = messages
      .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const openaiMessages = [
      { role: "system" as const, content: systemPrompt },
      ...trimmedMessages,
    ];

    // Streaming response
    if (wantStream) {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: openaiMessages,
        max_tokens: 4096,
        temperature: 0.3,
        stream: true,
      });

      let fullReply = "";

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content ?? "";
              if (delta) {
                fullReply += delta;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, detectedRepo: effectiveRepo ? { workspace: effectiveWs, repo: effectiveRepo } : null })}\n\n`));
            controller.close();

            // Save complete reply to DB
            if (sessionId) {
              await prisma.chatMessage.create({ data: { chatSessionId: sessionId, role: "assistant", content: fullReply } });
              await prisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Stream error";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: friendlyError(msg) })}\n\n`));
            controller.close();
          }
        },
      });

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming fallback
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: openaiMessages,
      max_tokens: 4096,
      temperature: 0.3,
    });

    const reply = completion.choices[0]?.message?.content ?? "Yanıt alınamadı.";

    if (sessionId) {
      await prisma.chatMessage.create({ data: { chatSessionId: sessionId, role: "assistant", content: reply } });
      await prisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
    }

    return new Response(JSON.stringify({ reply }), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Bilinmeyen hata";
    console.error("Chat API error:", message);
    return new Response(
      JSON.stringify({ error: friendlyError(message) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ─── Friendly error messages ────────────────────────

function friendlyError(msg: string): string {
  if (msg.includes("429") && msg.includes("TPM")) {
    return "⏳ API kullanım limiti aşıldı. Lütfen birkaç saniye bekleyip tekrar deneyin.";
  }
  if (msg.includes("429")) {
    return "⏳ Çok fazla istek gönderildi. Lütfen biraz bekleyin.";
  }
  if (msg.includes("401") || msg.includes("Incorrect API key")) {
    return "🔑 OpenAI API anahtarı geçersiz. .env dosyasını kontrol edin.";
  }
  if (msg.includes("insufficient_quota")) {
    return "💳 OpenAI hesabınızda yeterli kredi yok.";
  }
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return "⏱️ İstek zaman aşımına uğradı. Lütfen tekrar deneyin.";
  }
  if (msg.includes("context_length_exceeded")) {
    return "📏 Repo çok büyük, bağlam limiti aşıldı. Daha spesifik bir soru sorun.";
  }
  return `Bir hata oluştu: ${msg.slice(0, 100)}`;
}

// ─── Helpers ────────────────────────────────────────

interface WorkspaceWithRepos {
  slug: string; name: string;
  repositories: { slug: string; name: string }[];
}

interface RepoMatch {
  workspace: string;
  repo: string;
  name: string;
  confidence: "exact" | "fuzzy";
}

function detectRepoFromMessage(msg: string, workspaces: WorkspaceWithRepos[]): RepoMatch | null {
  const q = msg.toLowerCase();
  const allRepos: { ws: string; slug: string; name: string }[] = [];
  for (const ws of workspaces)
    for (const r of ws.repositories)
      allRepos.push({ ws: ws.slug, slug: r.slug, name: r.name });

  // 1. Exact match (slug or name appears in message)
  for (const r of allRepos) {
    if (q.includes(r.slug.toLowerCase()) || q.includes(r.name.toLowerCase())) {
      return { workspace: r.ws, repo: r.slug, name: r.name, confidence: "exact" };
    }
  }

  // 2. Fuzzy match — find best similarity
  const words = q.replace(/[^a-z0-9\s-_]/g, "").split(/\s+/).filter((w) => w.length > 2);
  let bestMatch: typeof allRepos[0] | null = null;
  let bestScore = 0;

  for (const r of allRepos) {
    const slugParts = r.slug.toLowerCase().replace(/[-_]/g, " ").split(" ");
    const nameParts = r.name.toLowerCase().replace(/[-_]/g, " ").split(" ");
    const repoParts = [...new Set([...slugParts, ...nameParts])];

    let score = 0;
    for (const word of words) {
      for (const part of repoParts) {
        if (part.includes(word) || word.includes(part)) {
          score += Math.min(word.length, part.length);
        }
        // Levenshtein-like: if only 1-2 chars different
        if (part.length > 3 && word.length > 3 && Math.abs(part.length - word.length) <= 2) {
          let diff = 0;
          const shorter = part.length < word.length ? part : word;
          const longer = part.length < word.length ? word : part;
          for (let i = 0; i < shorter.length; i++) {
            if (shorter[i] !== longer[i]) diff++;
          }
          diff += longer.length - shorter.length;
          if (diff <= 2) score += shorter.length - diff;
        }
      }
    }

    if (score > bestScore && score >= 3) {
      bestScore = score;
      bestMatch = r;
    }
  }

  if (bestMatch) {
    return { workspace: bestMatch.ws, repo: bestMatch.slug, name: bestMatch.name, confidence: "fuzzy" };
  }

  return null;
}

function buildWorkspaceContext(workspaces: WorkspaceWithRepos[]): string {
  if (!workspaces.length) return "";
  const p = ["## Erişilebilir Repolar\n"];
  for (const ws of workspaces)
    for (const r of ws.repositories) {
      const desc = (r as { description?: string }).description;
      const lang = (r as { language?: string }).language;
      p.push(`- **${r.name}** (\`${ws.slug}/${r.slug}\`)${lang ? ` [${lang}]` : ""}${desc ? ` — ${desc}` : ""}`);
    }
  return p.join("\n");
}

function buildSystemPrompt(wCtx: string, rCtx: string, ws?: string, repo?: string, repoLabel?: string): string {
  const base = `Sen bir şirket içi kıdemli yazılım mühendisi ve kod analiz uzmanısın. Bitbucket repolarını derinlemesine analiz edip, teknik ve teknik olmayan kişilerin anlayabileceği şekilde açıklıyorsun.

Kurallar:
- Her zaman Türkçe yanıt ver. Markdown kullan.
- Repo isimlerini **kalın** yaz.
- Teknik terimlerde parantez içinde Türkçe açıklama ekle.
- Dosyalar arası bağımlılıkları ve veri akışını açıkla.
- Güvenlik açıkları veya sorunlar görürsen belirt.
- Detaylı rapor istendiğinde: Proje özeti, teknoloji yığını, mimari, DB şeması, API yapısı, iş mantığı, konfigürasyon, bağımlılıklar, geliştirme durumu başlıklarıyla yanıt ver.
- Emin olmadığın bilgileri uydurma.`;

  let ctx = base + "\n\n";
  if (wCtx) ctx += wCtx + "\n\n";
  if (rCtx) ctx += `"${repoLabel ?? `${ws}/${repo}`}" reposu analiz edilmiş:\n\n${rCtx}`;
  else if (ws && repo) ctx += `"${ws}/${repo}" henüz indekslenmemiş.`;
  else ctx += "Repo seçili değil.";
  return ctx;
}

// ─── Smart repo context builder ─────────────────────

async function buildRepoContext(wsSlug: string, repoSlug: string, userQuery = ""): Promise<string> {
  const repo = await prisma.repository.findFirst({
    where: { slug: repoSlug, workspace: { slug: wsSlug } },
    include: {
      files: { select: { path: true, language: true, size: true, content: true }, orderBy: { path: "asc" } },
      commits: { select: { hash: true, message: true, authorName: true, date: true, filesChanged: true }, orderBy: { date: "desc" }, take: 20 },
      pullRequests: { select: { prNumber: true, title: true, description: true, state: true, authorName: true, sourceBranch: true, targetBranch: true, filesChanged: true }, orderBy: { updatedDate: "desc" }, take: 15 },
      branches: { select: { name: true }, orderBy: { name: "asc" } },
    },
  });
  if (!repo) return "";

  // Two-phase: ask AI which files are relevant, then send only those
  const selectedFiles = await selectRelevantFiles(repo, userQuery);
  return buildRepoContextFromData(repo, userQuery, selectedFiles);
}

// Phase 1: Ask AI to select relevant files based on the question
async function selectRelevantFiles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo: any,
  userQuery: string
): Promise<Set<string> | null> {
  // Skip file selection for simple queries or small repos
  if (!userQuery || repo.files.length < 15) return null;

  // Skip for queries that clearly want everything
  if (/dosya|file|yapı|structure|ağaç|tree|genel|özet|rapor|detay/i.test(userQuery)) return null;

  const fileList = repo.files
    .map((f: { path: string; language: string | null; size: number | null }) =>
      `${f.path} (${f.language ?? "?"}${f.size ? `, ${Math.round(f.size / 1024)}KB` : ""})`
    )
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Sen bir dosya seçici asistansın. Kullanıcının sorusuna cevap vermek için hangi dosyaların okunması gerektiğini belirle.

Kurallar:
- Sadece dosya yollarını döndür, her satıra bir tane.
- En fazla 15 dosya seç.
- README, package.json, schema dosyaları genellikle faydalıdır.
- Soruyla ilgili olmayan dosyaları seçme.
- Başka bir şey yazma, sadece dosya yolları.`
        },
        {
          role: "user",
          content: `Repo: ${repo.fullName}\n\nDosyalar:\n${fileList}\n\nSoru: ${userQuery}\n\nBu soruyu cevaplamak için hangi dosyaları okumalıyım?`
        }
      ],
      max_tokens: 500,
      temperature: 0,
    });

    const answer = response.choices[0]?.message?.content ?? "";
    const selected = new Set<string>();

    for (const line of answer.split("\n")) {
      const trimmed = line.trim().replace(/^[-*•]\s*/, "").replace(/`/g, "").trim();
      if (trimmed && repo.files.some((f: { path: string }) => f.path === trimmed)) {
        selected.add(trimmed);
      }
    }

    // Always include README and key config files
    for (const f of repo.files) {
      const name = (f as { path: string }).path.split("/").pop()?.toLowerCase() ?? "";
      if (name === "readme.md" || name === "package.json" || name === "schema.prisma") {
        selected.add((f as { path: string }).path);
      }
    }

    return selected.size > 0 ? selected : null;
  } catch {
    // If file selection fails, fall back to default behavior
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRepoContextFromData(repo: any, userQuery = "", selectedFiles: Set<string> | null = null): string {
  type F = { path: string; language: string | null; size: number | null; content: string | null };
  type C = { hash: string; message: string; authorName: string; date: Date; filesChanged: string | null };
  type PR = { prNumber: number; title: string; description: string | null; state: string; authorName: string; sourceBranch: string; targetBranch: string; filesChanged: number };
  type B = { name: string };

  const files: F[] = repo.files;
  const commits: C[] = repo.commits;
  const pullRequests: PR[] = repo.pullRequests;
  const branches: B[] = repo.branches;
  const q = userQuery.toLowerCase();
  const parts: string[] = [];

  const langStats: Record<string, number> = {};
  for (const f of files) langStats[f.language ?? "Diğer"] = (langStats[f.language ?? "Diğer"] ?? 0) + 1;
  parts.push(`## ${repo.fullName}`);
  parts.push(`${repo.description ?? ""} | ${repo.language ?? "?"} | ${repo.defaultBranch} | ${files.length} dosya`);
  parts.push(`Diller: ${Object.entries(langStats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, c]) => `${l}:${c}`).join(", ")}\n`);

  const wantsCommits = /commit|değişik|geçmiş|history|log/i.test(q);
  const wantsPRs = /pr|pull.?request|merge/i.test(q);
  const wantsBranches = /branch|dal/i.test(q);
  const wantsFiles = /dosya|file|yapı|structure|ağaç|tree/i.test(q);
  const wantsSpecific = findFileRef(q, files.map((f) => f.path));
  const wantsOverview = /ne işe|nedir|açıkla|analiz|rapor|özet|proje|teknoloji|mimari|api|endpoint|route|detay/i.test(q);
  const isGeneral = !wantsCommits && !wantsPRs && !wantsBranches && !wantsFiles && !wantsSpecific && !wantsOverview;

  if (wantsFiles || wantsOverview || isGeneral) {
    parts.push("## Dosya Yapısı");
    parts.push(buildFileTree(files.map((f) => f.path)));
    parts.push("");
  }

  if (wantsBranches || wantsOverview) {
    parts.push(`## Branch'ler (${branches.length})`);
    branches.forEach((b) => parts.push(`- ${b.name}${b.name === repo.defaultBranch ? " ⭐" : ""}`));
    parts.push("");
  }

  const MAX = 50000;
  let used = 0;

  if (wantsSpecific) {
    const f = files.find((f) => f.path.toLowerCase() === wantsSpecific!.toLowerCase());
    if (f?.content) {
      const imports = extractImports(f.content, files.map((ff) => ff.path), f.path);
      const c = f.content.length > 8000 ? f.content.slice(0, 8000) + "\n...(kırpıldı)" : f.content;
      parts.push(`## ${f.path}\n\`\`\`${f.language?.toLowerCase() ?? ""}\n${c}\n\`\`\`\n`);
      used += c.length;

      for (const imp of imports) {
        const impFile = files.find((ff) => ff.path === imp);
        if (impFile?.content && used < MAX) {
          const ic = impFile.content.length > 3000 ? impFile.content.slice(0, 3000) + "\n...(kırpıldı)" : impFile.content;
          parts.push(`### İlişkili: ${impFile.path}\n\`\`\`${impFile.language?.toLowerCase() ?? ""}\n${ic}\n\`\`\`\n`);
          used += ic.length;
        }
      }
    }
  }

  if (wantsOverview || isGeneral || wantsFiles) {
    const PRIO = new Set(["readme.md", "readme.txt", "readme"]);
    const CONF = new Set(["package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod", "dockerfile", "docker-compose.yml", ".env.example", "tsconfig.json", "bitbucket-pipelines.yml"]);
    const SCHEMA = new Set(["schema.prisma", "schema.sql"]);
    const SKIP = /migration|\.lock|lock\.json|\.min\.|node_modules|dist\/|build\/|\.map$/i;

    const emit = (file: F, max: number, icon: string) => {
      if (!file.content || used > MAX) return;
      const c = file.content.length > max ? file.content.slice(0, max) + "\n...(kırpıldı)" : file.content;
      parts.push(`\n### ${icon} ${file.path}\n\`\`\`${file.language?.toLowerCase() ?? ""}\n${c}\n\`\`\``);
      used += c.length;
    };

    if (selectedFiles) {
      // Phase 2: AI selected specific files — send those with higher budget
      for (const f of files) {
        if (selectedFiles.has(f.path)) {
          emit(f, 6000, "🎯");
        }
      }
    } else {
      // Default: priority-based selection
      files.filter((f) => PRIO.has(f.path.split("/").pop()?.toLowerCase() ?? "")).forEach((f) => emit(f, 5000, "📄"));
      files.filter((f) => CONF.has(f.path.split("/").pop()?.toLowerCase() ?? "")).forEach((f) => emit(f, 3000, "⚙️"));
      files.filter((f) => SCHEMA.has(f.path.split("/").pop()?.toLowerCase() ?? "")).forEach((f) => emit(f, 5000, "🗄️"));

      if (wantsOverview || /api|endpoint|route/i.test(q)) {
        files.filter((f) => /route|controller|service/i.test(f.path) && !SKIP.test(f.path)).forEach((f) => emit(f, 2000, "🔌"));
      }

      files.filter((f) => {
        const name = f.path.split("/").pop()?.toLowerCase() ?? "";
        return !PRIO.has(name) && !CONF.has(name) && !SCHEMA.has(name) &&
          !/route|controller|service/i.test(f.path) && !SKIP.test(f.path);
      }).forEach((f) => emit(f, 2000, ""));
    }

    if (used >= MAX) parts.push("\n...(bağlam limiti)");
    parts.push("");
  }

  if (wantsCommits || wantsOverview || isGeneral) {
    const n = wantsCommits ? 20 : 8;
    parts.push(`## Son Commit'ler`);
    commits.slice(0, n).forEach((c) => {
      const d = c.date.toISOString().split("T")[0];
      const fc = c.filesChanged ? ` | ${c.filesChanged.split(",").slice(0, 3).join(", ")}` : "";
      parts.push(`- [${c.hash.slice(0, 7)}] ${d} ${c.authorName}: ${c.message.split("\n")[0]}${fc}`);
    });
    parts.push("");
  }

  if (wantsPRs || wantsOverview || isGeneral) {
    const n = wantsPRs ? 15 : 5;
    parts.push(`## Pull Request'ler`);
    pullRequests.slice(0, n).forEach((pr) => {
      parts.push(`- PR #${pr.prNumber} [${pr.state}] "${pr.title}" (${pr.authorName}, ${pr.sourceBranch}→${pr.targetBranch}, ${pr.filesChanged} dosya)`);
      if (pr.description && wantsPRs) parts.push(`  ${pr.description.slice(0, 200)}`);
    });
  }

  return parts.join("\n");
}

// ─── GitHub repo context (by fullName) ──────────────

async function buildRepoContextById(fullName: string, userQuery: string): Promise<string> {
  const repo = await prisma.repository.findFirst({
    where: { source: "github", fullName },
    include: {
      files: { select: { path: true, language: true, size: true, content: true }, orderBy: { path: "asc" } },
      commits: { select: { hash: true, message: true, authorName: true, date: true, filesChanged: true }, orderBy: { date: "desc" }, take: 20 },
      pullRequests: { select: { prNumber: true, title: true, description: true, state: true, authorName: true, sourceBranch: true, targetBranch: true, filesChanged: true }, orderBy: { updatedDate: "desc" }, take: 15 },
      branches: { select: { name: true }, orderBy: { name: "asc" } },
    },
  });
  if (!repo) return "";
  const selectedFiles = await selectRelevantFiles(repo, userQuery);
  return buildRepoContextFromData(repo, userQuery, selectedFiles);
}

// ─── Extract imports from a file to find related files ──

function extractImports(content: string, allPaths: string[], currentPath: string): string[] {
  const dir = currentPath.split("/").slice(0, -1).join("/");
  const imports: string[] = [];
  // Match: import ... from "..." or require("...")
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      if (importPath.startsWith(".")) {
        // Resolve relative path
        const resolved = resolveRelativePath(dir, importPath);
        // Try with common extensions
        for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]) {
          const full = resolved + ext;
          if (allPaths.includes(full)) { imports.push(full); break; }
        }
      }
    }
  }
  return imports.slice(0, 5); // Max 5 related files
}

function resolveRelativePath(dir: string, rel: string): string {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function findFileRef(q: string, paths: string[]): string | null {
  for (const p of paths) { const n = p.split("/").pop()?.toLowerCase() ?? ""; if (n.length > 3 && q.includes(n)) return p; }
  for (const p of paths) if (q.includes(p.toLowerCase())) return p;
  return null;
}

function buildFileTree(paths: string[]): string {
  interface N { children: Map<string, N> }
  const root: N = { children: new Map() };
  for (const p of paths) { let c = root; for (const s of p.split("/")) { if (!c.children.has(s)) c.children.set(s, { children: new Map() }); c = c.children.get(s)!; } }
  function r(n: N, pre: string, isRoot: boolean): string[] {
    const lines: string[] = [];
    const entries = [...n.children.entries()].sort(([a], [b]) => {
      const ad = n.children.get(a)!.children.size > 0, bd = n.children.get(b)!.children.size > 0;
      return ad !== bd ? (ad ? -1 : 1) : a.localeCompare(b);
    });
    entries.forEach(([name, child], i) => {
      const last = i === entries.length - 1;
      const conn = isRoot ? "" : (last ? "└── " : "├── ");
      const np = isRoot ? "" : pre + (last ? "    " : "│   ");
      const dir = child.children.size > 0;
      lines.push(`${isRoot ? "" : pre}${conn}${dir ? "📁 " : ""}${name}`);
      if (dir) lines.push(...r(child, np, false));
    });
    return lines;
  }
  return r(root, "", true).join("\n");
}
