import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = request.nextUrl.searchParams.get("workspace");
  const repo = request.nextUrl.searchParams.get("repo");
  if (!workspace || !repo) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  const repository = await prisma.repository.findFirst({
    where: {
      slug: repo,
      workspace: {
        slug: workspace,
        users: { some: { userId: session.user.id } },
      },
    },
    include: {
      _count: { select: { files: true, commits: true, pullRequests: true, branches: true } },
    },
  });

  if (!repository) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    files: repository._count.files,
    commits: repository._count.commits,
    branches: repository._count.branches,
    pullRequests: repository._count.pullRequests,
  });
}
