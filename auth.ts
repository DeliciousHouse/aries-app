import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import pool from "./lib/db";
import { resolveAuthRuntimeConfig } from "./lib/auth-runtime-config";
import type { TenantRole } from "./lib/tenant-context";
import {
  ensureTenantAccessForUser,
  findTenantClaimsByEmail,
  findTenantClaimsByUserId,
  isTenantRole,
  missingTenantClaims,
  normalizeEmail,
  tenantClaimsErrorRedirect,
} from "./lib/auth-tenant-membership";

const authRuntime = resolveAuthRuntimeConfig(process.env);
const DATABASE_UNAVAILABLE_ERROR = "DatabaseUnavailable";

class DatabaseUnavailableCredentialsError extends CredentialsSignin {
  code = DATABASE_UNAVAILABLE_ERROR;
}

function buildLoginErrorUrl(error: string): string {
  return `/login?error=${encodeURIComponent(error)}`;
}

if (authRuntime.authUrl) {
  process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? authRuntime.authUrl;
  process.env.AUTH_URL = process.env.AUTH_URL ?? authRuntime.authUrl;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: authRuntime.trustHost,
  providers: [
    Credentials({
      name: "Email and Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        let client;
        const email =
          typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";

        if (!email || !password) {
          return null;
        }

        try {
          client = await pool.connect();
          const result = await client.query(
            `
              SELECT id, email, full_name, password_hash
              FROM users
              WHERE LOWER(email) = LOWER($1)
              LIMIT 1
            `,
            [email],
          );

          if ((result.rowCount ?? 0) === 0) {
            return null;
          }

          const row = result.rows[0] as {
            id: string | number;
            email: string;
            full_name?: string | null;
            password_hash: string;
          };

          if (
            !row.password_hash ||
            row.password_hash === "oauth_managed" ||
            !row.password_hash.startsWith("$2")
          ) {
            return null;
          }

          const passwordMatches = await bcrypt.compare(password, row.password_hash);
          if (!passwordMatches) {
            return null;
          }

          return {
            id: String(row.id),
            email: row.email,
            name: row.full_name || row.email,
          };
        } catch (error) {
          console.error("Error during credentials authorization:", error);
          throw new DatabaseUnavailableCredentialsError();
        } finally {
          client?.release();
        }
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google" && account?.provider !== "credentials") {
        return true;
      }

      const email = user.email;
      if (!email) return false;
      const normalizedEmail = normalizeEmail(email);

      let client;
      try {
        client = await pool.connect();
        const existingUser = await client.query(
          "SELECT id, organization_id, role FROM users WHERE LOWER(email) = LOWER($1)",
          [normalizedEmail],
        );

        let authenticatedUser =
          (existingUser.rowCount ?? 0) > 0
            ? (existingUser.rows[0] as {
                id: string | number;
                organization_id?: string | number | null;
                role?: string | null;
              })
            : null;

        if (account.provider === "google") {
          if ((existingUser.rowCount ?? 0) === 0) {
            const inserted = await client.query(
              `
                INSERT INTO users (email, full_name, password_hash)
                VALUES ($1, $2, $3)
                RETURNING id, organization_id, role
              `,
              [normalizedEmail, user.name || "", "oauth_managed"],
            );
            authenticatedUser = inserted.rows[0] as {
              id: string | number;
              organization_id?: string | number | null;
              role?: string | null;
            };
          }
        } else if ((existingUser.rowCount ?? 0) === 0) {
          return false;
        }

        if (!authenticatedUser) {
          return false;
        }

        await ensureTenantAccessForUser(client, {
          userId: authenticatedUser.id,
          organizationId: authenticatedUser.organization_id,
          role: authenticatedUser.role,
          name: user.name,
          email: normalizedEmail,
        });

        const tenantClaims = await findTenantClaimsByUserId(
          client,
          Number(authenticatedUser.id),
        );
        const missingClaims = missingTenantClaims(tenantClaims);
        if (missingClaims.length > 0) {
          console.error("Authenticated user is missing required tenant claims after sign-in.", {
            provider: account.provider,
            email: normalizedEmail,
            userId: String(authenticatedUser.id),
            missingClaims,
          });
          return tenantClaimsErrorRedirect(missingClaims);
        }

        return true;
      } catch (err) {
        console.error(`Error during ${account?.provider || "auth"} sign in:`, err);
        return buildLoginErrorUrl(DATABASE_UNAVAILABLE_ERROR);
      } finally {
        client?.release();
      }
    },
    async jwt({ token, user }) {
      const hydrateTenantClaimsByUserId = async (userId: string) => {
        const client = await pool.connect();
        try {
          const row = await findTenantClaimsByUserId(client, userId);
          if (!row || missingTenantClaims(row).length > 0) {
            return;
          }

          token.tenantId = String(row.tenant_id);
          token.tenantSlug = row.tenant_slug as string;
          token.tenantRole = row.role as TenantRole;
        } finally {
          client.release();
        }
      };

      if (user?.email) {
        const client = await pool.connect();
        try {
          const row = await findTenantClaimsByEmail(client, normalizeEmail(user.email));

          if (row) {
            token.userId = String(row.user_id);
            if (missingTenantClaims(row).length === 0) {
              token.tenantId = String(row.tenant_id);
              token.tenantSlug = row.tenant_slug as string;
              token.tenantRole = isTenantRole(row.role) ? row.role : undefined;
            }
          }
        } finally {
          client.release();
        }
      } else if (!token.userId && token.sub) {
        token.userId = token.sub;
      }

      if (token.userId) {
        await hydrateTenantClaimsByUserId(String(token.userId));
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = String(token.userId);
      }
      if (session.user && token.tenantId && token.tenantSlug && token.tenantRole) {
        session.user.tenantId = String(token.tenantId);
        session.user.tenantSlug = String(token.tenantSlug);
        session.user.role = isTenantRole(token.tenantRole) ? token.tenantRole : undefined;
      }

      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
