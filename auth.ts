import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import pool from "./lib/db";

export const { handlers, signIn, signOut, auth } = NextAuth({
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
          
          if (existingUser.rowCount === 0) {
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
    async session({ session, token }) {
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
