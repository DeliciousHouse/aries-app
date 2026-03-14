import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import pool from "./lib/db";
import { resolveAuthRuntimeConfig } from "./lib/auth-runtime-config";

const authRuntime = resolveAuthRuntimeConfig(process.env);

if (authRuntime.authUrl) {
  process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? authRuntime.authUrl;
  process.env.AUTH_URL = process.env.AUTH_URL ?? authRuntime.authUrl;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: authRuntime.trustHost,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        const email = user.email;
        if (!email) return false;

        const client = await pool.connect();
        try {
          // Check if user exists, if not create them
          const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
          
          if ((existingUser.rowCount ?? 0) === 0) {
            await client.query(
              'INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)',
              [email, user.name || '', 'oauth_managed']
            );
          }
          return true;
        } catch (err) {
          console.error("Error during Google sign in:", err);
          return false;
        } finally {
          client.release();
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const client = await pool.connect();
        try {
          const result = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [user.email]);
          if ((result.rowCount ?? 0) > 0) {
            token.userId = String(result.rows[0].id);
          }
        } finally {
          client.release();
        }
      } else if (!token.userId && token.sub) {
        token.userId = token.sub;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user && token.userId) {
        session.user.id = String(token.userId);
      }

      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
