import { NextRequest, NextResponse } from "next/server";
import { parseGitHubUrl } from "@/lib/github";
import { syncGitHubRepo } from "@/lib/github-indexer";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const { url } = await request.json();

  // Rate limit by IP (no auth required for GitHub)
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "anonymous";
  const rl = checkRateLimit(ip, "/api/github/analyze");
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `⏳ Çok fazla istek. ${Math.ceil(rl.resetIn / 1000)} saniye bekleyin.` },
      { status: 429 }
    );
  }

  if (!url || typeof url !== "string" || url.length > 200) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid GitHub URL" }, { status: 400 });
  }

  // Validate owner/repo format to prevent injection
  if (!/^[a-zA-Z0-9_.-]+$/.test(parsed.owner) || !/^[a-zA-Z0-9_.-]+$/.test(parsed.repo)) {
    return NextResponse.json({ error: "Invalid repository name" }, { status: 400 });
  }

  try {
    const result = await syncGitHubRepo(parsed.owner, parsed.repo);
    return NextResponse.json({
      repoId: result.repoId,
      fullName: `${parsed.owner}/${parsed.repo}`,
      slug: parsed.repo,
      source: "github",
      skipped: result.skipped,
      filesIndexed: result.filesIndexed,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("404")) {
      return NextResponse.json({ error: "Repo bulunamadı. Public bir GitHub reposu olduğundan emin olun." }, { status: 404 });
    }
    if (msg.includes("403")) {
      return NextResponse.json({ error: "GitHub API rate limit aşıldı. Biraz bekleyin." }, { status: 429 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
