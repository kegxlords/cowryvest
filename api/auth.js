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
  for (let i = 0; i < 20; i++) {
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

async function ensureProfileExists(userId, fullName, email, referredBy = null) {
  const { data: existingProfile, error: existingError } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, referral_code, referred_by')
    .eq('id', userId)
    .maybeSingle();

  if (existingError) throw existingError;

  // Case 1: profile already exists
  if (existingProfile) {
    const updates = {};

    if (!existingProfile.referral_code) {
      updates.referral_code = await getUniqueReferralCode();
    }

    if (!existingProfile.full_name && fullName) {
      updates.full_name = fullName;
    }

    if (!existingProfile.email && email) {
      updates.email = email;
    }

    // Do not overwrite referred_by for existing users.
    // This protects referral attribution.

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', userId);

      if (updateError) throw updateError;
    }

    return existingProfile;
  }

  // Case 2: profile does not exist yet
  const referralCode = await getUniqueReferralCode();

  const { data: insertedProfile, error: insertError } = await supabaseAdmin
    .from('profiles')
    .insert({
      id: userId,
      full_name: fullName,
      email,
      role: 'user',
      main_balance: 0,
      frozen_balance: 0,
      referral_code: referralCode,
      referred_by: referredBy
    })
    .select()
    .maybeSingle();

  if (insertError) {
    // Race condition or trigger may have created it between select and insert.
    const { data: lateExistingProfile, error: lateError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (lateError) throw lateError;
    if (lateExistingProfile) return lateExistingProfile;

    throw insertError;
  }

  return insertedProfile;
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
      const fullName = String(body.full_name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const referralCodeInput = String(body.referral_code || '').trim().toUpperCase();

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

        if (referrerError) throw referrerError;

        if (!referrer) {
          return res.status(400).json({ error: 'Invalid referral code' });
        }

        referredBy = referrer.id;
      }

      let authUserId = null;
      let session = null;
      let user = null;
      let accountAlreadyExisted = false;

      // Try creating the auth user.
      const { data: createdAuthUser, error: createAuthError } =
        await supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: fullName
          }
        });

      if (createAuthError) {
        const message = String(createAuthError.message || '').toLowerCase();

        // If user already exists, try signing in with the submitted password.
        if (
          message.includes('already registered') ||
          message.includes('user already') ||
          message.includes('already exists')
        ) {
          const { data: existingSignIn, error: existingSignInError } =
            await supabaseClient.auth.signInWithPassword({
              email,
              password
            });

          if (existingSignInError) {
            return res.status(409).json({
              error:
                'An account with this email already exists. Please log in or reset your password.'
            });
          }

          authUserId = existingSignIn.user.id;
          session = existingSignIn.session;
          user = existingSignIn.user;
          accountAlreadyExisted = true;

          // Do not change referred_by for existing accounts.
          await ensureProfileExists(authUserId, fullName, email, null);
        } else {
          return res.status(400).json({ error: createAuthError.message });
        }
      } else {
        authUserId = createdAuthUser.user.id;
        user = createdAuthUser.user;

        // Create profile safely.
        await ensureProfileExists(authUserId, fullName, email, referredBy);

        // Sign in the newly created user.
        const { data: newSignIn, error: newSignInError } =
          await supabaseClient.auth.signInWithPassword({
            email,
            password
          });

        if (newSignInError) {
          return res.status(400).json({ error: newSignInError.message });
        }

        session = newSignIn.session;
        user = newSignIn.user;
      }

      return res.status(200).json({
        success: true,
        account_already_existed: accountAlreadyExisted,
        session,
        user
      });
    }

    // ==========================
    // LOGIN
    // ==========================
    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

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

      // Safety: ensure profile exists even for older auth users.
      await ensureProfileExists(data.user.id, '', email, null);

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
