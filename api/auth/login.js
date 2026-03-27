import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabase = createClient(
  'https://wcdwuqzcjeijraenioes.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZHd1cXpjamVpanJhZW5pb2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNjY4MjcsImV4cCI6MjA4Nzc0MjgyN30.q-xWnSmq_1YTr5T35CCG3ChHV7Cps13fE3_V3btrUFQ'
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const trimmedUsername = username.trim().toLowerCase();

  try {
    // Find user
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password_hash, created_at')
      .eq('username', trimmedUsername)
      .single();

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Return user (without password hash)
    return res.status(200).json({
      user: {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
