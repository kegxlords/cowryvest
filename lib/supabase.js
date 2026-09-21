// lib/supabase.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://wpexaabwwesjtgcgadlw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZXhhYWJ3d2VzanRnY2dhZGx3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODc1MDUsImV4cCI6MjEwNTU2MzUwNX0.dfR2jHKL6V2dZmvZVvZmpuIpyi1xSey9_FGI43lcEao';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});
