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

  // Validate
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const trimmedUsername = username.trim().toLowerCase();

  if (trimmedUsername.length < 3 || trimmedUsername.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }

  if (!/^[a-z0-9_]+$/.test(trimmedUsername)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  try {
    // Check if username taken
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', trimmedUsername)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const { data: user, error } = await supabase
      .from('users')
      .insert({ username: trimmedUsername, password_hash })
      .select('id, username, created_at')
      .single();

    if (error) throw error;

    return res.status(200).json({ user });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
