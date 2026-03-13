"use server";

import pool from '@/lib/db';
import bcrypt from 'bcryptjs';

export async function checkEmailExistsAction(email: string) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    return result.rowCount > 0;
  } finally {
    client.release();
  }
}

export async function registerUserAction(formData: any) {
  const { email, password, fullName, orgName } = formData;
  
  let client;
  try {
    client = await pool.connect();
    
    // 1. Check if user already exists
    const existingUser = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existingUser.rowCount && existingUser.rowCount > 0) {
      return { success: false, error: 'User already exists' };
    }

    // 2. Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Create organization if it doesn't exist
    let orgId = null;
    if (orgName) {
      const orgResult = await client.query(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
        [orgName]
      );
      orgId = orgResult.rows[0].id;
    }

    // 4. Create user
    const userResult = await client.query(
      'INSERT INTO users (email, password_hash, full_name, organization_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, hashedPassword, fullName, orgId]
    );

    return { success: true, userId: userResult.rows[0].id };
  } catch (err: any) {
    console.error('Registration error:', err);
    return { success: false, error: err.message || 'Registration failed' };
  } finally {
    if (client) client.release();
  }
}
