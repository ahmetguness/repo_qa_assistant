-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "folderId" TEXT;

-- CreateTable
CREATE TABLE "chat_folders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_folders_userId_idx" ON "chat_folders"("userId");

-- AddForeignKey
ALTER TABLE "chat_folders" ADD CONSTRAINT "chat_folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "chat_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
