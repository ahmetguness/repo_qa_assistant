/*
  Warnings:

  - A unique constraint covering the columns `[source,fullName]` on the table `repositories` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'bitbucket',
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "repositories_source_fullName_key" ON "repositories"("source", "fullName");
