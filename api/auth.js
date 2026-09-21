// api/auth.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

function getBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function generateReferralCode() {
  return 'CV' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function getUniqueReferralCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateReferralCode();
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('referral_code', code)
      .maybeSingle();

    if (error) throw error;
    if (!data) return code;
  }

  throw new Error('Unable to generate unique referral code');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = getBody(req);
    const action = body.action;

    // ==========================
    // REGISTER
    // ==========================
    if (action === 'register') {
      const fullName = (body.full_name || '').trim();
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      const referralCodeInput = (body.referral_code || '').trim().toUpperCase();

      if (!fullName) {
        return res.status(400).json({ error: 'Full name is required' });
      }

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }

      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      let referredBy = null;

      if (referralCodeInput) {
        const { data: referrer, error: referrerError } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('referral_code', referralCodeInput)
          .maybeSingle();

        if (referrerError) {
          throw referrerError;
        }

        if (!referrer) {
          return res.status(400).json({ error: 'Invalid referral code' });
        }

        referredBy = referrer.id;
      }

      const { data: createdUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: fullName
        }
      });

      if (createError) {
        return res.status(400).json({ error: createError.message });
      }

      const userId = createdUser.user.id;
      const referralCode = await getUniqueReferralCode();

      const { error: profileError } = await supabaseAdmin.from('profiles').insert({
        id: userId,
        full_name: fullName,
        email,
        role: 'user',
        main_balance: 0,
        frozen_balance: 0,
        referral_code: referralCode,
        referred_by: referredBy
      });

      if (profileError) {
        // Optional: clean up auth user if profile insert fails
        await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
        return res.status(400).json({ error: profileError.message });
      }

      const { data: signInData, error: signInError } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (signInError) {
        return res.status(400).json({ error: signInError.message });
      }

      return res.status(200).json({
        success: true,
        session: signInData.session,
        user: signInData.user
      });
    }

    // ==========================
    // LOGIN
    // ==========================
    if (action === 'login') {
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      return res.status(200).json({
        success: true,
        session: data.session,
        user: data.user
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Auth API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
