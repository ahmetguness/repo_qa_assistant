import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// PATCH: Rename folder
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { folderId } = await params;
  const { name } = await request.json();

  if (!name || typeof name !== "string" || name.length > 100) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  await prisma.chatFolder.updateMany({
    where: { id: folderId, userId: session.user.id },
    data: { name: name.trim().slice(0, 100) },
  });

  return NextResponse.json({ ok: true });
}

// DELETE: Delete folder (sessions become unfiled)
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { folderId } = await params;

  // Unfile sessions first
  await prisma.chatSession.updateMany({
    where: { folderId, userId: session.user.id },
    data: { folderId: null },
  });

  await prisma.chatFolder.deleteMany({
    where: { id: folderId, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
