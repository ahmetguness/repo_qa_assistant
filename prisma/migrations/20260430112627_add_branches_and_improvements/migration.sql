-- AlterTable
ALTER TABLE "repo_commits" ADD COLUMN     "filesChanged" TEXT;

-- AlterTable
ALTER TABLE "repo_pull_requests" ADD COLUMN     "filesChanged" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "repo_branches" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commitHash" TEXT,

    CONSTRAINT "repo_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repo_branches_repositoryId_idx" ON "repo_branches"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "repo_branches_repositoryId_name_key" ON "repo_branches"("repositoryId", "name");

-- AddForeignKey
ALTER TABLE "repo_branches" ADD CONSTRAINT "repo_branches_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
