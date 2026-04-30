import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: Get messages for a session
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, createdAt: true },
      },
    },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ session: chatSession });
}

// PATCH: Update session title
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;
  const body = await request.json();
  const { title, folderId } = body;

  const data: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== "string" || title.length > 200) {
      return NextResponse.json({ error: "Invalid title" }, { status: 400 });
    }
    data.title = title.trim().slice(0, 200);
  }
  if (folderId !== undefined) data.folderId = folderId;
  if (body.workspaceSlug !== undefined) data.workspaceSlug = typeof body.workspaceSlug === "string" ? body.workspaceSlug.slice(0, 100) : null;
  if (body.repositorySlug !== undefined) data.repositorySlug = typeof body.repositorySlug === "string" ? body.repositorySlug.slice(0, 200) : null;

  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId: session.user.id },
    data,
  });

  return NextResponse.json({ ok: true });
}

// DELETE: Delete a session
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await params;

  await prisma.chatSession.deleteMany({
    where: { id: sessionId, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
