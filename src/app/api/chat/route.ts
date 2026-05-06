import { NextRequest } from "next/server";
import OpenAI from "openai";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_HISTORY_MESSAGES = 8;
const CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";
const FILE_SELECTOR_MODEL = process.env.OPENAI_FILE_SELECTOR_MODEL ?? "gpt-4.1-mini";
const parsedMaxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 3000);
const CHAT_MAX_OUTPUT_TOKENS = Number.isFinite(parsedMaxOutputTokens)
  ? Math.min(Math.max(parsedMaxOutputTokens, 1000), 6000)
  : 3000;
const parsedTpmBudget = Number(process.env.OPENAI_TPM_BUDGET ?? 28000);
const OPENAI_TPM_BUDGET = Number.isFinite(parsedTpmBudget)
  ? Math.min(Math.max(parsedTpmBudget, 8000), 200000)
  : 28000;
const parsedContextChars = Number(process.env.AI_CONTEXT_CHARS ?? 90000);
const MAX_CONTEXT_CHARS = Number.isFinite(parsedContextChars)
  ? Math.min(Math.max(parsedContextChars, 20000), 180000)
  : 90000;
const FILE_SELECTOR_MAX_FILES = 300;
const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTEXT_CACHE_MAX = 80;
const MAX_EVIDENCE_CHARS = 18000;

const contextCache = new Map<string, { value: string; expiresAt: number }>();

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
      repoContext = await buildRepoContext(effectiveWs, effectiveRepo, session.user.id, userQuery);
    }

    // Trim conversation history to save tokens
    const trimmedMessages = messages
      .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const repoLabel = githubRepo ?? (effectiveWs && effectiveRepo ? `${effectiveWs}/${effectiveRepo}` : undefined);
    const workspaceContext = buildWorkspaceContext(userWorkspaces);
    repoContext = fitRepoContextToTokenBudget({
      repoContext,
      workspaceContext,
      userQuery,
      effectiveWs,
      effectiveRepo,
      repoLabel,
      fuzzyHint,
      history: trimmedMessages,
    });
    const systemPrompt = buildSystemPrompt(
      workspaceContext, repoContext, userQuery, effectiveWs, effectiveRepo, repoLabel
    ) + fuzzyHint;

    const openaiMessages = [
      { role: "system" as const, content: systemPrompt },
      ...trimmedMessages,
    ];

    // Streaming response
    if (wantStream) {
      const stream = await openai.chat.completions.create({
        model: CHAT_MODEL,
        messages: openaiMessages,
        max_tokens: CHAT_MAX_OUTPUT_TOKENS,
        temperature: 0.1,
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
      model: CHAT_MODEL,
      messages: openaiMessages,
      max_tokens: CHAT_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
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

function buildContextCacheKey(repoId: string, lastSyncedAt: Date | null | undefined, userQuery: string): string {
  return [
    repoId,
    lastSyncedAt?.getTime() ?? 0,
    normalizeQuery(userQuery).slice(0, 160),
  ].join(":");
}

function getContextCache(key: string): string | null {
  const item = contextCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    contextCache.delete(key);
    return null;
  }
  return item.value;
}

function setContextCache(key: string, value: string) {
  if (contextCache.size >= CONTEXT_CACHE_MAX) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey) contextCache.delete(oldestKey);
  }
  contextCache.set(key, { value, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyQuestionIntent(query: string): string {
  const q = normalizeQuery(query);
  if (/listele|göster|hangi repo|repolar|workspace/.test(q)) return "listeleme / seçim";
  if (/nasıl|akış|flow|çalışıyor|ne yapıyor|mantık/.test(q)) return "işleyiş ve veri akışı";
  if (/hata|bug|sorun|neden|niye|çalışmıyor|fix|düzelt/.test(q)) return "hata teşhisi";
  if (/güvenlik|security|yetki|auth|token|secret|risk/.test(q)) return "güvenlik incelemesi";
  if (/performans|hız|yavaş|optimizasyon|cache/.test(q)) return "performans incelemesi";
  if (/api|endpoint|route/.test(q)) return "API yüzeyi";
  if (/db|database|prisma|schema|model|tablo/.test(q)) return "veri modeli";
  if (/detay|rapor|analiz|mimari|overview|özet/.test(q)) return "genel repo analizi";
  return "hedefli teknik soru";
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

function buildSystemPrompt(wCtx: string, rCtx: string, userQuery: string, ws?: string, repo?: string, repoLabel?: string): string {
  const base = `Sen bir şirket içi kıdemli yazılım mühendisi ve kod analiz uzmanısın. Bitbucket repolarını derinlemesine analiz edip, teknik ve teknik olmayan kişilerin anlayabileceği şekilde açıklıyorsun.

Kurallar:
- Her zaman Türkçe yanıt ver. Markdown kullan.
- Repo isimlerini **kalın** yaz.
- Teknik terimlerde parantez içinde Türkçe açıklama ekle.
- Dosyalar arası bağımlılıkları ve veri akışını açıkla.
- Güvenlik açıkları veya sorunlar görürsen belirt.
- Detaylı rapor istendiğinde: Proje özeti, teknoloji yığını, mimari, DB şeması, API yapısı, iş mantığı, konfigürasyon, bağımlılıklar, geliştirme durumu başlıklarıyla yanıt ver.
- Emin olmadığın bilgileri uydurma.`;

  const qualityRules = `

Ek kalite kuralları:
- Cevabı sadece verilen repo bağlamına ve erişilebilir repo listesine dayandır. Emin değilsen "Bu bağlamda görünmüyor" de.
- Önemli her teknik iddiada dosya yolu kaynak göster: örn. [src/lib/auth.ts].
- Dosyalar arası bağımlılıkları, veri akışını ve kullanıcı akışını birlikte açıkla.
- Güvenlik, yetkilendirme, veri sızıntısı, rate limit, hata yönetimi veya production riski görürsen "Riskler" bölümünde belirt.
- Genel analiz istenirse şu sırayı kullan: Kısa özet, Kanıtlı bulgular, Mimari, Veri modeli, API/iş akışı, Riskler, İyileştirme önerileri, Kaynaklar.
- Kısa sorularda gereksiz rapor yazma; doğrudan cevap ver, ama kritik iddiaları kaynakla.
- "Listele", "göster", "hangi repolar" gibi repo seçimi sorularında analiz yapma; erişilebilir repo listesini net biçimde ver.
- Uydurma isim, endpoint, tablo, env var veya bağımlılık yazma.`;

  const answerContract = `

Nokta atışı cevap sözleşmesi:
- Soru niyeti: ${classifyQuestionIntent(userQuery)}.
- Önce doğrudan cevabı 2-5 cümlede ver.
- Sonra en fazla 3-6 maddeyle kanıtlı teknik açıklama yap.
- Her maddede mümkünse \`[dosya/yolu]\` kaynak göster.
- "Kanıt Parçaları" bölümündeki line numaralı parçalar varsa onları birincil kaynak kabul et.
- Bağlamda cevap yoksa tahmin yürütme; hangi dosyanın eksik olabileceğini söyle.
- Kullanıcı özellikle detaylı rapor istemediyse tüm repo raporu yazma.`;

  let ctx = base + qualityRules + answerContract + "\n\n";
  if (wCtx) ctx += wCtx + "\n\n";
  if (rCtx) ctx += `"${repoLabel ?? `${ws}/${repo}`}" reposu analiz edilmiş:\n\n${rCtx}`;
  else if (ws && repo) ctx += `"${ws}/${repo}" henüz indekslenmemiş.`;
  else ctx += "Repo seçili değil.";
  return ctx;
}

type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: ChatHistoryMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 8, 0);
}

function fitRepoContextToTokenBudget({
  repoContext,
  workspaceContext,
  userQuery,
  effectiveWs,
  effectiveRepo,
  repoLabel,
  fuzzyHint,
  history,
}: {
  repoContext: string;
  workspaceContext: string;
  userQuery: string;
  effectiveWs?: string;
  effectiveRepo?: string;
  repoLabel?: string;
  fuzzyHint: string;
  history: ChatHistoryMessage[];
}): string {
  if (!repoContext) return repoContext;

  const historyTokens = estimateMessagesTokens(history);
  const reserveTokens = CHAT_MAX_OUTPUT_TOKENS + historyTokens + 700;
  const maxPromptTokens = Math.max(4000, OPENAI_TPM_BUDGET - reserveTokens);

  let current = repoContext;
  for (let i = 0; i < 6; i++) {
    const prompt = buildSystemPrompt(workspaceContext, current, userQuery, effectiveWs, effectiveRepo, repoLabel) + fuzzyHint;
    if (estimateTokens(prompt) <= maxPromptTokens) return current;

    const nextLength = Math.floor(current.length * 0.82);
    if (nextLength >= current.length || nextLength < 4000) break;
    current = current.slice(0, nextLength);
  }

  return current.slice(0, Math.max(4000, maxPromptTokens * 4)) + "\n\n...(OpenAI TPM butcesine sigmasi icin repo baglami kisaltildi)";
}

// ─── Smart repo context builder ─────────────────────

async function buildRepoContext(wsSlug: string, repoSlug: string, userId: string, userQuery = ""): Promise<string> {
  const repo = await prisma.repository.findFirst({
    where: {
      slug: repoSlug,
      workspace: {
        slug: wsSlug,
        users: { some: { userId } },
      },
    },
    include: {
      files: { select: { path: true, language: true, size: true }, orderBy: { path: "asc" } },
      commits: { select: { hash: true, message: true, authorName: true, date: true, filesChanged: true }, orderBy: { date: "desc" }, take: 20 },
      pullRequests: { select: { prNumber: true, title: true, description: true, state: true, authorName: true, sourceBranch: true, targetBranch: true, filesChanged: true }, orderBy: { updatedDate: "desc" }, take: 15 },
      branches: { select: { name: true }, orderBy: { name: "asc" } },
    },
  });
  if (!repo) return "";

  const cacheKey = buildContextCacheKey(repo.id, repo.lastSyncedAt, userQuery);
  const cached = getContextCache(cacheKey);
  if (cached) return cached;

  // Two-phase: ask AI which files are relevant, then send only those
  const selectedFiles = await selectRelevantFiles(repo, userQuery);
  const hydratedRepo = await hydrateRepoContent(repo, selectedFiles, userQuery);
  const context = buildRepoContextFromData(hydratedRepo, userQuery, selectedFiles);
  setContextCache(cacheKey, context);
  return context;
}

type RepoFileMeta = {
  path: string;
  language: string | null;
  size: number | null;
};

type RepoFileWithContent = RepoFileMeta & {
  content: string | null;
};

type RepoCommitContext = {
  hash: string;
  message: string;
  authorName: string;
  date: Date;
  filesChanged: string | null;
};

type RepoPullRequestContext = {
  prNumber: number;
  title: string;
  description: string | null;
  state: string;
  authorName: string;
  sourceBranch: string;
  targetBranch: string;
  filesChanged: number;
};

type RepoBranchContext = {
  name: string;
};

type RepoContextBase = {
  id: string;
  fullName: string;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  lastSyncedAt: Date | null;
  files: RepoFileMeta[];
  commits: RepoCommitContext[];
  pullRequests: RepoPullRequestContext[];
  branches: RepoBranchContext[];
};

type HydratedRepoContext = Omit<RepoContextBase, "files"> & {
  files: RepoFileWithContent[];
};

// Phase 1: Ask AI to select relevant files based on the question
async function selectRelevantFiles(repo: RepoContextBase, userQuery: string): Promise<Set<string> | null> {
  const heuristicSelected = selectHeuristicFiles(repo.files, userQuery);

  // Skip file selection for simple queries or small repos
  if (!userQuery || repo.files.length < 15) return heuristicSelected.size > 0 ? heuristicSelected : null;

  // Skip for queries that clearly want everything
  if (/dosya|file|yapı|structure|ağaç|tree|genel|özet|rapor|detay/i.test(userQuery)) {
    return heuristicSelected.size > 0 ? heuristicSelected : null;
  }

  const selectorCandidates = rankFilesForQuery(repo.files, userQuery, heuristicSelected)
    .slice(0, FILE_SELECTOR_MAX_FILES);
  const fileList = selectorCandidates
    .map((f) =>
      `${f.path} (${f.language ?? "?"}${f.size ? `, ${Math.round(f.size / 1024)}KB` : ""})`
    )
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: FILE_SELECTOR_MODEL,
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
    const selected = new Set<string>(heuristicSelected);

    for (const line of answer.split("\n")) {
      const trimmed = line.trim().replace(/^[-*•]\s*/, "").replace(/`/g, "").trim();
      if (trimmed && repo.files.some((f) => f.path === trimmed)) {
        selected.add(trimmed);
      }
    }

    // Always include README and key config files
    for (const f of repo.files) {
      const name = f.path.split("/").pop()?.toLowerCase() ?? "";
      if (name === "readme.md" || name === "package.json" || name === "schema.prisma") {
        selected.add(f.path);
      }
    }

    return selected.size > 0 ? selected : null;
  } catch {
    // If file selection fails, fall back to default behavior
    return heuristicSelected.size > 0 ? heuristicSelected : null;
  }
}

function selectHeuristicFiles(
  files: { path: string; language: string | null; size: number | null; content?: string | null }[],
  userQuery: string
): Set<string> {
  const selected = new Set<string>();
  const q = userQuery.toLowerCase();
  const addIf = (predicate: (path: string, name: string) => boolean, limit: number) => {
    for (const file of files) {
      if (selected.size >= limit) break;
      const path = file.path.toLowerCase();
      const name = path.split("/").pop() ?? path;
      if (predicate(path, name)) selected.add(file.path);
    }
  };

  addIf((_, name) => ["readme.md", "package.json", "schema.prisma", ".env.example"].includes(name), 8);

  if (/auth|login|oauth|token|session|yetki|giriş|kimlik/i.test(q)) {
    addIf((path) => /auth|login|session|token|adapter|middleware/.test(path), 18);
  }
  if (/api|endpoint|route|controller|istek|request/i.test(q)) {
    addIf((path) => /\/api\/|route\.|controller|handler|server/.test(path), 22);
  }
  if (/db|database|prisma|schema|model|migration|tablo|veri/i.test(q)) {
    addIf((path) => /prisma|schema|migration|db|database|model/.test(path), 18);
  }
  if (/ui|component|frontend|sayfa|ekran|react|tasarım/i.test(q)) {
    addIf((path) => /component|app\/.*page|layout|globals\.css/.test(path), 18);
  }
  if (/test|build|deploy|ci|docker|env|config|ayar/i.test(q)) {
    addIf((path, name) => /test|spec|docker|ci|workflow|pipeline|config|eslint|tsconfig|next\.config/.test(path) || name.startsWith("."), 18);
  }

  const queryWords = q
    .replace(/[^a-z0-9çğıöşü_-]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
  const scored = files
    .map((file) => ({ file, score: scoreFileForQuery(file, queryWords, selected) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24);
  for (const item of scored) selected.add(item.file.path);

  return selected;
}

function rankFilesForQuery(
  files: { path: string; language: string | null; size: number | null; content?: string | null }[],
  userQuery: string,
  preferred: Set<string>
): typeof files {
  const queryWords = normalizeQuery(userQuery)
    .replace(/[^a-z0-9çğıöşü_-]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);

  return [...files].sort((a, b) =>
    scoreFileForQuery(b, queryWords, preferred) - scoreFileForQuery(a, queryWords, preferred)
  );
}

function scoreFileForQuery(
  file: { path: string; language: string | null; size: number | null; content?: string | null },
  queryWords: string[],
  preferred: Set<string>
): number {
  const path = file.path.toLowerCase();
  const name = path.split("/").pop() ?? path;
  const content = file.content?.toLowerCase() ?? "";
  let score = preferred.has(file.path) ? 80 : 0;

  if (["readme.md", "package.json", "schema.prisma", ".env.example"].includes(name)) score += 35;
  if (/\/api\/|route\.|controller|handler/.test(path)) score += 18;
  if (/auth|login|session|token|adapter|middleware/.test(path)) score += 18;
  if (/prisma|schema|migration|database|db/.test(path)) score += 14;
  if (/component|page|layout|globals\.css/.test(path)) score += 8;
  if (/test|spec|__tests__/.test(path)) score += 6;

  for (const word of queryWords) {
    if (path.includes(word)) score += Math.min(word.length * 5, 30);
    if (name.includes(word)) score += Math.min(word.length * 6, 36);
    if (content.includes(word)) score += Math.min(word.length * 2, 18);
  }

  if (file.size && file.size > 150_000) score -= 12;
  return score;
}

function buildRepoProfile(
  files: { path: string; language: string | null; size: number | null; content?: string | null }[],
  selectedFiles: Set<string> | null
): string {
  const byName = (names: string[]) =>
    files
      .filter((file) => names.includes(file.path.split("/").pop()?.toLowerCase() ?? ""))
      .map((file) => file.path);
  const matching = (pattern: RegExp, limit: number) =>
    files.filter((file) => pattern.test(file.path)).slice(0, limit).map((file) => file.path);

  const keyFiles = [
    ...byName(["readme.md", "package.json", "requirements.txt", "pyproject.toml", "go.mod", "cargo.toml"]),
    ...byName(["schema.prisma", ".env.example", "dockerfile", "docker-compose.yml"]),
  ];
  const apiFiles = matching(/\/api\/|route\.|controller|handler/i, 24);
  const authFiles = matching(/auth|login|session|token|adapter|middleware/i, 18);
  const dataFiles = matching(/prisma|schema|migration|database|db/i, 18);
  const uiFiles = matching(/component|app\/.*page|layout|globals\.css/i, 18);
  const testFiles = matching(/test|spec|__tests__|\.test\.|\.spec\./i, 18);
  const activeSources = selectedFiles ? [...selectedFiles] : keyFiles.slice(0, 30);
  const intelligenceFiles = selectedFiles
    ? files.filter((file) => selectedFiles.has(file.path))
    : files.filter((file) =>
        keyFiles.includes(file.path) ||
        /\/api\/|route\.|controller|handler|auth|session|prisma|schema|component|page|layout/i.test(file.path)
      ).slice(0, 60);

  const line = (label: string, paths: string[]) =>
    paths.length ? `- ${label}: ${[...new Set(paths)].slice(0, 30).map((path) => `\`${path}\``).join(", ")}` : "";
  return [
    "## Repo Profili ve Kaynak Haritası",
    line("Ana kaynaklar", keyFiles),
    line("Soru için seçilen kaynaklar", activeSources),
    line("API/route adayları", apiFiles),
    line("Auth/session adayları", authFiles),
    line("Veri modeli/DB adayları", dataFiles),
    line("UI/component adayları", uiFiles),
    line("Test adayları", testFiles),
    buildPackageSummary(files),
    buildApiRouteSummary(files),
    buildPrismaSummary(files),
    buildSymbolSummary(intelligenceFiles),
    buildEnvSummary(files),
    buildImportSummary(intelligenceFiles, files.map((file) => file.path)),
    buildRiskSignalSummary(files),
    "Cevap verirken yukarıdaki dosya yollarını kaynak olarak kullan.",
  ].filter(Boolean).join("\n");
}

type ProfileFile = {
  path: string;
  language: string | null;
  size: number | null;
  content?: string | null;
};

function buildPackageSummary(files: ProfileFile[]): string {
  const packageFile = files.find((file) => file.path.split("/").pop()?.toLowerCase() === "package.json" && file.content);
  if (!packageFile?.content) return "";
  try {
    const pkg = JSON.parse(packageFile.content) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.entries(pkg.scripts ?? {}).map(([name, command]) => `${name}=${command}`);
    const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 25);
    const devDeps = Object.keys(pkg.devDependencies ?? {}).slice(0, 20);
    return [
      "## Package Özeti",
      `- Kaynak: \`${packageFile.path}\``,
      scripts.length ? `- Scripts: ${scripts.map((script) => `\`${script}\``).join(", ")}` : "",
      deps.length ? `- Dependencies: ${deps.map((dep) => `\`${dep}\``).join(", ")}` : "",
      devDeps.length ? `- Dev dependencies: ${devDeps.map((dep) => `\`${dep}\``).join(", ")}` : "",
    ].filter(Boolean).join("\n");
  } catch {
    return `## Package Özeti\n- \`${packageFile.path}\` JSON parse edilemedi.`;
  }
}

function buildApiRouteSummary(files: ProfileFile[]): string {
  const routes = files
    .filter((file) => /(^|\/)app\/api\/.*\/route\.(ts|tsx|js|jsx)$/.test(file.path) && file.content)
    .map((file) => {
      const methods = [...file.content!.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
        .map((match) => match[1]);
      const route = "/" + file.path
        .replace(/^src\//, "")
        .replace(/^app\/api/, "api")
        .replace(/\/route\.(ts|tsx|js|jsx)$/, "")
        .replace(/\[([^\]]+)\]/g, ":$1");
      return `- \`${route}\` [${methods.length ? methods.join(", ") : "method yok"}] -> \`${file.path}\``;
    })
    .slice(0, 50);
  return routes.length ? ["## API Route Haritası", ...routes].join("\n") : "";
}

function buildPrismaSummary(files: ProfileFile[]): string {
  const schema = files.find((file) => /schema\.prisma$/i.test(file.path) && file.content);
  if (!schema?.content) return "";
  const models = [...schema.content.matchAll(/^model\s+(\w+)\s*{([\s\S]*?)^}/gm)]
    .map((match) => {
      const fields = match[2]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
        .map((line) => line.split(/\s+/).slice(0, 2).join(":"))
        .slice(0, 10);
      return `- \`${match[1]}\`: ${fields.join(", ")}`;
    })
    .slice(0, 30);
  return models.length ? ["## Prisma Model Özeti", `- Kaynak: \`${schema.path}\``, ...models].join("\n") : "";
}

function buildSymbolSummary(files: ProfileFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (!file.content || !/\.(ts|tsx|js|jsx|py|go|java|cs|rs|rb|php)$/i.test(file.path)) continue;
    const symbols = new Set<string>();
    const patterns = [
      /export\s+default\s+function\s+([A-Za-z0-9_]+)/g,
      /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
      /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
      /export\s+(?:class|interface|type)\s+([A-Za-z0-9_]+)/g,
      /function\s+([A-Za-z0-9_]+)\s*\(/g,
      /class\s+([A-Za-z0-9_]+)/g,
    ];
    for (const pattern of patterns) {
      for (const match of file.content.matchAll(pattern)) symbols.add(match[1]);
    }
    if (symbols.size) lines.push(`- \`${file.path}\`: ${[...symbols].slice(0, 12).map((symbol) => `\`${symbol}\``).join(", ")}`);
    if (lines.length >= 45) break;
  }
  return lines.length ? ["## Sembol/Export Haritası", ...lines].join("\n") : "";
}

function buildEnvSummary(files: ProfileFile[]): string {
  const envVars = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.content) continue;
    for (const match of file.content.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!envVars.has(match[1])) envVars.set(match[1], new Set());
      envVars.get(match[1])!.add(file.path);
    }
  }
  const lines = [...envVars.entries()].slice(0, 40).map(([name, paths]) =>
    `- \`${name}\`: ${[...paths].slice(0, 5).map((path) => `\`${path}\``).join(", ")}`
  );
  return lines.length ? ["## Env Kullanımı", ...lines].join("\n") : "";
}

function buildImportSummary(files: ProfileFile[], allPaths: string[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (!file.content || !/\.(ts|tsx|js|jsx)$/i.test(file.path)) continue;
    const imports = extractImports(file.content, allPaths, file.path);
    if (imports.length) lines.push(`- \`${file.path}\` -> ${imports.map((path) => `\`${path}\``).join(", ")}`);
    if (lines.length >= 35) break;
  }
  return lines.length ? ["## Import İlişki Haritası", ...lines].join("\n") : "";
}

function buildRiskSignalSummary(files: ProfileFile[]): string {
  const checks: { label: string; pattern: RegExp }[] = [
    { label: "raw HTML / XSS riski", pattern: /dangerouslySetInnerHTML|innerHTML\s*=|document\.write/i },
    { label: "dinamik kod çalıştırma", pattern: /\beval\s*\(|new Function\s*\(/i },
    { label: "token/secret kullanımı", pattern: /access_token|refresh_token|api[_-]?key|secret|password/i },
    { label: "TODO/FIXME", pattern: /TODO|FIXME|HACK/i },
    { label: "gevşek tip kullanımı", pattern: new RegExp(":\\s*" + "a" + "ny\\b|<" + "a" + "ny>", "i") },
    { label: "console logging", pattern: /console\.(log|error|warn)/i },
  ];
  const lines: string[] = [];
  for (const check of checks) {
    const hits = files
      .filter((file) => file.content && check.pattern.test(file.content))
      .map((file) => file.path)
      .slice(0, 10);
    if (hits.length) lines.push(`- ${check.label}: ${hits.map((path) => `\`${path}\``).join(", ")}`);
  }
  return lines.length ? ["## Otomatik Risk Sinyalleri", ...lines].join("\n") : "";
}

async function hydrateRepoContent(
  repo: RepoContextBase,
  selectedFiles: Set<string> | null,
  userQuery: string
): Promise<HydratedRepoContext> {
  const contentPaths = chooseContentPaths(repo.files, selectedFiles, userQuery);
  if (!contentPaths.size) {
    return {
      ...repo,
      files: repo.files.map((file: ProfileFile) => ({ ...file, content: null })),
    };
  }

  const contentRows = await prisma.repoFile.findMany({
    where: { repositoryId: repo.id, path: { in: [...contentPaths] } },
    select: { path: true, content: true },
  });
  const contentByPath = new Map(contentRows.map((row) => [row.path, row.content]));
  return {
    ...repo,
    files: repo.files.map((file: ProfileFile) => ({
      ...file,
      content: contentByPath.get(file.path) ?? null,
    })),
  };
}

function chooseContentPaths(
  files: ProfileFile[],
  selectedFiles: Set<string> | null,
  userQuery: string
): Set<string> {
  const paths = new Set<string>();
  const add = (path?: string | null) => { if (path) paths.add(path); };
  const addMatching = (pattern: RegExp, limit: number) => {
    for (const file of files) {
      if (paths.size >= 120) break;
      if (pattern.test(file.path)) {
        add(file.path);
        if (--limit <= 0) break;
      }
    }
  };

  for (const file of files) {
    const name = file.path.split("/").pop()?.toLowerCase() ?? "";
    if (["readme.md", "package.json", "schema.prisma", ".env.example"].includes(name)) add(file.path);
  }
  selectedFiles?.forEach(add);

  const q = normalizeQuery(userQuery);
  if (/auth|login|oauth|token|session|yetki|giriş|kimlik/.test(q)) addMatching(/auth|login|session|token|adapter|middleware/i, 28);
  if (/api|endpoint|route|controller|istek|request/.test(q)) addMatching(/\/api\/|route\.|controller|handler/i, 35);
  if (/db|database|prisma|schema|model|migration|tablo|veri/.test(q)) addMatching(/prisma|schema|migration|database|db/i, 24);
  if (/ui|component|frontend|sayfa|ekran|react|tasarım/.test(q)) addMatching(/component|app\/.*page|layout|globals\.css/i, 24);

  for (const file of rankFilesForQuery(files, userQuery, selectedFiles ?? new Set()).slice(0, 50)) {
    add(file.path);
  }

  return paths;
}

function buildEvidenceSnippets(
  files: ProfileFile[],
  userQuery: string,
  selectedFiles: Set<string> | null
): string {
  const terms = extractQueryTerms(userQuery);
  if (!terms.length) return "";

  const candidates = rankFilesForQuery(files, userQuery, selectedFiles ?? new Set())
    .filter((file) => file.content)
    .slice(0, 24);
  const snippets: string[] = [];
  let used = 0;

  for (const file of candidates) {
    if (!file.content || used >= MAX_EVIDENCE_CHARS) break;
    const lines = file.content.split(/\r?\n/);
    const matchedIndexes = lines
      .map((line, index) => ({ line: line.toLowerCase(), index }))
      .filter(({ line }) => terms.some((term) => line.includes(term)))
      .map(({ index }) => index);

    const windows = mergeLineWindows(matchedIndexes, 3).slice(0, 2);
    for (const [start, end] of windows) {
      const body = lines
        .slice(start, end + 1)
        .map((line, offset) => `${String(start + offset + 1).padStart(4, " ")} | ${line}`)
        .join("\n");
      if (!body.trim()) continue;
      const snippet = `### ${file.path}:${start + 1}-${end + 1}\n\`\`\`${file.language?.toLowerCase() ?? ""}\n${body}\n\`\`\``;
      snippets.push(snippet);
      used += snippet.length;
      if (used >= MAX_EVIDENCE_CHARS) break;
    }
  }

  return snippets.length
    ? ["## Kanıt Parçaları", "Aşağıdaki parçalar kullanıcı sorusuyla doğrudan eşleşen en güçlü kanıtlardır.", ...snippets].join("\n")
    : "";
}

function extractQueryTerms(query: string): string[] {
  const stopWords = new Set([
    "nedir", "nasıl", "hangi", "bana", "için", "olan", "repo", "proje",
    "this", "that", "what", "how", "where", "when", "does", "with",
  ]);
  return [...new Set(normalizeQuery(query)
    .replace(/[^a-z0-9çğıöşü_/-]+/gi, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !stopWords.has(term))
  )].slice(0, 14);
}

function mergeLineWindows(indexes: number[], radius: number): [number, number][] {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const index of sorted) {
    const start = Math.max(0, index - radius);
    const end = index + radius;
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }
  return windows;
}

function buildRepoContextFromData(repo: HydratedRepoContext, userQuery = "", selectedFiles: Set<string> | null = null): string {
  const files = repo.files;
  const commits = repo.commits;
  const pullRequests = repo.pullRequests;
  const branches = repo.branches;
  const q = userQuery.toLowerCase();
  const parts: string[] = [];

  const langStats: Record<string, number> = {};
  for (const f of files) langStats[f.language ?? "Diğer"] = (langStats[f.language ?? "Diğer"] ?? 0) + 1;
  parts.push(`## ${repo.fullName}`);
  parts.push(`${repo.description ?? ""} | ${repo.language ?? "?"} | ${repo.defaultBranch} | ${files.length} dosya`);
  parts.push(`Diller: ${Object.entries(langStats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, c]) => `${l}:${c}`).join(", ")}\n`);
  parts.push(buildRepoProfile(files, selectedFiles));
  parts.push(buildEvidenceSnippets(files, userQuery, selectedFiles));
  parts.push("");

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

  const MAX = MAX_CONTEXT_CHARS;
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
      for (const dependent of findReverseImports(f.path, files).slice(0, 5)) {
        if (dependent.content && used < MAX) {
          const dc = dependent.content.length > 2500 ? dependent.content.slice(0, 2500) + "\n...(truncated)" : dependent.content;
          parts.push(`### Dependent: ${dependent.path}\n\`\`\`${dependent.language?.toLowerCase() ?? ""}\n${dc}\n\`\`\`\n`);
          used += dc.length;
        }
      }
    }
  }

  if (wantsOverview || isGeneral || wantsFiles) {
    const PRIO = new Set(["readme.md", "readme.txt", "readme"]);
    const CONF = new Set(["package.json", "requirements.txt", "pyproject.toml", "cargo.toml", "go.mod", "dockerfile", "docker-compose.yml", ".env.example", "tsconfig.json", "bitbucket-pipelines.yml"]);
    const SCHEMA = new Set(["schema.prisma", "schema.sql"]);
    const SKIP = /migration|\.lock|lock\.json|\.min\.|node_modules|dist\/|build\/|\.map$/i;

    const emit = (file: RepoFileWithContent, max: number, icon: string) => {
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
      for (const f of files) {
        if (!selectedFiles.has(f.path) || !f.content || used > MAX) continue;
        const imports = extractImports(f.content, files.map((ff) => ff.path), f.path);
        for (const importPath of imports) {
          const imported = files.find((file) => file.path === importPath);
          if (imported && !selectedFiles.has(imported.path)) {
            emit(imported, 3000, "related");
          }
        }
        for (const dependent of findReverseImports(f.path, files).slice(0, 3)) {
          if (!selectedFiles.has(dependent.path)) emit(dependent, 2500, "dependent");
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
      files: { select: { path: true, language: true, size: true }, orderBy: { path: "asc" } },
      commits: { select: { hash: true, message: true, authorName: true, date: true, filesChanged: true }, orderBy: { date: "desc" }, take: 20 },
      pullRequests: { select: { prNumber: true, title: true, description: true, state: true, authorName: true, sourceBranch: true, targetBranch: true, filesChanged: true }, orderBy: { updatedDate: "desc" }, take: 15 },
      branches: { select: { name: true }, orderBy: { name: "asc" } },
    },
  });
  if (!repo) return "";
  const cacheKey = buildContextCacheKey(repo.id, repo.lastSyncedAt, userQuery);
  const cached = getContextCache(cacheKey);
  if (cached) return cached;

  const selectedFiles = await selectRelevantFiles(repo, userQuery);
  const hydratedRepo = await hydrateRepoContent(repo, selectedFiles, userQuery);
  const context = buildRepoContextFromData(hydratedRepo, userQuery, selectedFiles);
  setContextCache(cacheKey, context);
  return context;
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

function findReverseImports<T extends { path: string; content: string | null }>(
  targetPath: string,
  files: T[]
): T[] {
  const allPaths = files.map((file) => file.path);
  return files.filter((file) => {
    if (!file.content || file.path === targetPath) return false;
    return extractImports(file.content, allPaths, file.path).includes(targetPath);
  });
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
