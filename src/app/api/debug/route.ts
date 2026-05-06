import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/get-access-token";
import { getRepoTree } from "@/lib/bitbucket";
import { syncRepoContent } from "@/lib/indexer";
import { prisma } from "@/lib/prisma";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  const ws = "ahmetgunes-ceng";
  const repoSlug = "sloncar-rental-platform";
  const results: Record<string, unknown> = {};

  // Test tree helper
  try {
    const tree = await getRepoTree(accessToken, ws, repoSlug, "ai/kan-45-xdxd14");
    results["tree"] = { count: tree.length, entries: tree.slice(0, 10).map((e) => ({ path: e.path, type: e.type })) };
  } catch (e: unknown) {
    results["tree_error"] = e instanceof Error ? e.message : String(e);
  }

  // Full sync
  try {
    const syncResult = await syncRepoContent(accessToken, ws, repoSlug);
    results["sync"] = syncResult;
  } catch (e: unknown) {
    results["sync_error"] = e instanceof Error ? e.message : String(e);
  }

  // DB check
  const files = await prisma.repoFile.count({ where: { repository: { slug: repoSlug } } });
  const sampleFiles = await prisma.repoFile.findMany({
    where: { repository: { slug: repoSlug } },
    take: 10,
    select: { path: true, language: true, size: true },
  });
  results["db_files"] = files;
  results["sample"] = sampleFiles;

  return NextResponse.json(results);
}
