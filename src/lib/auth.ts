import NextAuth from "next-auth";
import { CustomPrismaAdapter } from "@/lib/auth-adapter";
import type { NextAuthConfig } from "next-auth";

export const authConfig: NextAuthConfig = {
  adapter: CustomPrismaAdapter(),
  providers: [
    {
      id: "bitbucket",
      name: "Bitbucket",
      type: "oauth",
      authorization: {
        url: "https://bitbucket.org/site/oauth2/authorize",
        params: { scope: "repository pullrequest account" },
      },
      token: "https://bitbucket.org/site/oauth2/access_token",
      userinfo: "https://api.bitbucket.org/2.0/user",
      clientId: process.env.AUTH_BITBUCKET_ID,
      clientSecret: process.env.AUTH_BITBUCKET_SECRET,
      profile(profile) {
        return {
          id: profile.uuid ?? profile.account_id,
          name: profile.display_name,
          email: profile.email ?? null,
          image: profile.links?.avatar?.href ?? null,
        };
      },
    },
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "database",
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
