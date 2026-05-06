import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/get-access-token";
import { syncRepositories } from "@/lib/indexer";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = request.nextUrl.searchParams.get("workspace");
  if (!workspace) {
    return NextResponse.json({ error: "workspace param required" }, { status: 400 });
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  try {
    await syncRepositories(accessToken, workspace);

    const repos = await prisma.repository.findMany({
      where: {
        workspace: {
          slug: workspace,
          users: { some: { userId: session.user.id } },
        },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
        fullName: true,
        description: true,
        language: true,
        isPrivate: true,
        lastSyncedAt: true,
      },
    });

    return NextResponse.json({ repos });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
