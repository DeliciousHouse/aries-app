import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";
import pool from "./lib/db";
import { resolveAuthRuntimeConfig } from "./lib/auth-runtime-config";
import type { TenantRole } from "./lib/tenant-context";

const authRuntime = resolveAuthRuntimeConfig(process.env);
const TENANT_ROLES = new Set<TenantRole>(["tenant_admin", "tenant_analyst", "tenant_viewer"]);

function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && TENANT_ROLES.has(value as TenantRole);
}

function slugFromIdentity(name: string | null | undefined, email: string): string {
  return (name || email.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function ensureOrganizationForUser(
  client: PoolClient,
  userId: number,
  name: string | null | undefined,
  email: string,
): Promise<void> {
  const slug = slugFromIdentity(name, email);
  const orgResult = await client.query(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [name || email, slug],
  );
  const orgId = orgResult.rows[0].id as number;
  await client.query("UPDATE users SET organization_id = $1 WHERE id = $2", [orgId, userId]);
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
        const email =
          typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";

        if (!email || !password) {
          return null;
        }

        const client = await pool.connect();
        try {
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
          return null;
        } finally {
          client.release();
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

      const client = await pool.connect();
      try {
        const existingUser = await client.query(
          "SELECT id, organization_id FROM users WHERE LOWER(email) = LOWER($1)",
          [email],
        );

        if (account.provider === "google") {
          if ((existingUser.rowCount ?? 0) === 0) {
            const inserted = await client.query(
              "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
              [email, user.name || "", "oauth_managed"],
            );
            await ensureOrganizationForUser(
              client,
              inserted.rows[0].id as number,
              user.name,
              email,
            );
            return true;
          }
        } else if ((existingUser.rowCount ?? 0) === 0) {
          return false;
        }

        if (!existingUser.rows[0].organization_id) {
          await ensureOrganizationForUser(
            client,
            existingUser.rows[0].id as number,
            user.name,
            email,
          );
        }

        return true;
      } catch (err) {
        console.error(`Error during ${account?.provider || "auth"} sign in:`, err);
        return false;
      } finally {
        client.release();
      }
    },
    async jwt({ token, user }) {
      const hydrateTenantClaimsByUserId = async (userId: string) => {
        const client = await pool.connect();
        try {
          const tenantResult = await client.query(
            `
              SELECT
                o.id AS tenant_id,
                COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text) AS tenant_slug,
                u.role
              FROM users u
              INNER JOIN organizations o ON o.id = u.organization_id
              WHERE u.id = $1
              LIMIT 1
            `,
            [Number(userId)]
          );

          if ((tenantResult.rowCount ?? 0) > 0) {
            const row = tenantResult.rows[0] as {
              tenant_id: string | number;
              tenant_slug: string;
              role: TenantRole;
            };
            token.tenantId = String(row.tenant_id);
            token.tenantSlug = row.tenant_slug;
            token.tenantRole = row.role;
          }
        } finally {
          client.release();
        }
      };

      if (user?.email) {
        const client = await pool.connect();
        try {
          const result = await client.query(
            `
              SELECT
                u.id AS user_id,
                o.id AS tenant_id,
                COALESCE(NULLIF(o.slug, ''), 'org-' || o.id::text) AS tenant_slug,
                u.role
              FROM users u
              LEFT JOIN organizations o ON o.id = u.organization_id
              WHERE u.email = $1
              LIMIT 1
            `,
            [user.email]
          );

          if ((result.rowCount ?? 0) > 0) {
            const row = result.rows[0] as {
              user_id: string | number;
              tenant_id?: string | number | null;
              tenant_slug?: string | null;
              role?: TenantRole | null;
            };
            token.userId = String(row.user_id);
            if (row.tenant_id && row.tenant_slug && row.role) {
              token.tenantId = String(row.tenant_id);
              token.tenantSlug = row.tenant_slug;
              token.tenantRole = isTenantRole(row.role) ? row.role : undefined;
            }
          }
        } finally {
          client.release();
        }
      } else if (!token.userId && token.sub) {
        token.userId = token.sub;
      }

      if (token.userId && (!token.tenantId || !token.tenantSlug || !token.tenantRole)) {
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
  },
});
