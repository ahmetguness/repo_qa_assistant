import type { Adapter, AdapterUser, AdapterSession } from "next-auth/adapters";
import { prisma } from "@/lib/prisma";
import { encrypt } from "@/lib/encryption";

export function CustomPrismaAdapter(): Adapter {
  return {
    async createUser(data) {
      const user = await prisma.user.create({
        data: {
          email: data.email,
          name: data.name,
          image: data.image,
          emailVerified: data.emailVerified,
        },
      });
      return user as AdapterUser;
    },

    async getUser(id) {
      const user = await prisma.user.findUnique({ where: { id } });
      return (user as AdapterUser) ?? null;
    },

    async getUserByEmail(email) {
      const user = await prisma.user.findUnique({ where: { email } });
      return (user as AdapterUser) ?? null;
    },

    async getUserByAccount({ provider, providerAccountId }) {
      const account = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        include: { user: true },
      });
      return (account?.user as AdapterUser) ?? null;
    },

    async updateUser(data) {
      const user = await prisma.user.update({
        where: { id: data.id },
        data: {
          name: data.name,
          email: data.email,
          image: data.image,
          emailVerified: data.emailVerified,
        },
      });
      return user as AdapterUser;
    },

    async deleteUser(id) {
      await prisma.user.delete({ where: { id } });
    },

    async linkAccount(data) {
      await prisma.account.create({
        data: {
          userId: data.userId,
          type: data.type,
          provider: data.provider,
          providerAccountId: data.providerAccountId,
          refresh_token: data.refresh_token ? encrypt(data.refresh_token) : null,
          access_token: data.access_token ? encrypt(data.access_token) : null,
          expires_at: data.expires_at,
          token_type: data.token_type,
          scope: data.scope,
          id_token: data.id_token ? encrypt(data.id_token) : null,
          session_state: data.session_state as string | undefined,
        },
      });
    },

    async unlinkAccount({ provider, providerAccountId }) {
      await prisma.account.delete({
        where: { provider_providerAccountId: { provider, providerAccountId } },
      });
    },

    async createSession(data) {
      const session = await prisma.session.create({
        data: {
          sessionToken: data.sessionToken,
          userId: data.userId,
          expires: data.expires,
        },
      });
      return session as AdapterSession;
    },

    async getSessionAndUser(sessionToken) {
      const session = await prisma.session.findUnique({
        where: { sessionToken },
        include: { user: true },
      });
      if (!session) return null;
      return {
        session: session as AdapterSession,
        user: session.user as AdapterUser,
      };
    },

    async updateSession(data) {
      const session = await prisma.session.update({
        where: { sessionToken: data.sessionToken },
        data: {
          expires: data.expires,
        },
      });
      return session as AdapterSession;
    },

    async deleteSession(sessionToken) {
      await prisma.session.delete({ where: { sessionToken } });
    },

    async createVerificationToken(data) {
      const token = await prisma.verificationToken.create({
        data: {
          identifier: data.identifier,
          token: data.token,
          expires: data.expires,
        },
      });
      return token;
    },

    async useVerificationToken({ identifier, token }) {
      try {
        const vt = await prisma.verificationToken.delete({
          where: { identifier_token: { identifier, token } },
        });
        return vt;
      } catch {
        return null;
      }
    },
  };
}
