import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: List all chat sessions for the current user
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessions = await prisma.chatSession.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      repositorySlug: true,
      workspaceSlug: true,
      folderId: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      ...s,
      messageCount: s._count.messages,
      _count: undefined,
    })),
  });
}

// POST: Create a new chat session
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { title, workspaceSlug, repositorySlug } = await request.json();

  const chatSession = await prisma.chatSession.create({
    data: {
      userId: session.user.id,
      title: title ?? "Yeni Sohbet",
      workspaceSlug: workspaceSlug ?? null,
      repositorySlug: repositorySlug ?? null,
    },
  });

  return NextResponse.json({ session: chatSession });
}
