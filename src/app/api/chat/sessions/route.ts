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

  // Limit sessions per user
  const sessionCount = await prisma.chatSession.count({ where: { userId: session.user.id } });
  if (sessionCount >= 500) {
    return NextResponse.json({ error: "Maksimum sohbet sayısına ulaşıldı (500)" }, { status: 400 });
  }

  const safeTitle = (typeof title === "string" ? title.trim().slice(0, 200) : "") || "Yeni Sohbet";

  const chatSession = await prisma.chatSession.create({
    data: {
      userId: session.user.id,
      title: safeTitle,
      workspaceSlug: typeof workspaceSlug === "string" ? workspaceSlug.slice(0, 100) : null,
      repositorySlug: typeof repositorySlug === "string" ? repositorySlug.slice(0, 200) : null,
    },
  });

  return NextResponse.json({ session: chatSession });
}
