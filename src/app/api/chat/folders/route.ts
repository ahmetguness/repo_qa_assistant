import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: List folders
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const folders = await prisma.chatFolder.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, createdAt: true },
  });

  return NextResponse.json({ folders });
}

// POST: Create folder
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await request.json();

  const folderName = (typeof name === "string" ? name.trim().slice(0, 100) : "") || "Yeni Klasör";

  // Limit folders per user
  const folderCount = await prisma.chatFolder.count({ where: { userId: session.user.id } });
  if (folderCount >= 50) {
    return NextResponse.json({ error: "Maksimum klasör sayısına ulaşıldı (50)" }, { status: 400 });
  }

  const folder = await prisma.chatFolder.create({
    data: { userId: session.user.id, name: folderName },
  });

  return NextResponse.json({ folder });
}
