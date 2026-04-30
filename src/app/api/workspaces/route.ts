import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/get-access-token";
import { syncWorkspaces } from "@/lib/indexer";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  try {
    await syncWorkspaces(accessToken, session.user.id);

    const workspaces = await prisma.workspace.findMany({
      where: {
        users: { some: { userId: session.user.id } },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({ workspaces });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
