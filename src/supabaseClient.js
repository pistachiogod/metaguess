import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://wcdwuqzcjeijraenioes.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjZHd1cXpjamVpanJhZW5pb2VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNjY4MjcsImV4cCI6MjA4Nzc0MjgyN30.q-xWnSmq_1YTr5T35CCG3ChHV7Cps13fE3_V3btrUFQ';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
