import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function getAccessToken(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;

  const account = await prisma.account.findFirst({
    where: {
      userId: session.user.id,
      provider: "bitbucket",
    },
  });

  if (!account?.access_token) return null;

  // Check if token is expired and refresh if needed
  if (account.expires_at && account.expires_at * 1000 < Date.now()) {
    if (!account.refresh_token) return null;

    try {
      const res = await fetch("https://bitbucket.org/site/oauth2/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${process.env.AUTH_BITBUCKET_ID}:${process.env.AUTH_BITBUCKET_SECRET}`
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: account.refresh_token,
        }),
      });

      if (!res.ok) return null;

      const tokens = await res.json();

      await prisma.account.update({
        where: { id: account.id },
        data: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? account.refresh_token,
          expires_at: Math.floor(Date.now() / 1000 + tokens.expires_in),
        },
      });

      return tokens.access_token;
    } catch {
      return null;
    }
  }

  return account.access_token;
}
