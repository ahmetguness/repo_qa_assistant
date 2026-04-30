import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/get-access-token";
import { syncRepoContent } from "@/lib/indexer";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspace, repo } = await request.json();
  if (!workspace || !repo) {
    return NextResponse.json(
      { error: "workspace and repo are required" },
      { status: 400 }
    );
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token" }, { status: 401 });
  }

  try {
    const result = await syncRepoContent(accessToken, workspace, repo);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
