// api/referral.js
import {
  supabaseAdmin,
  getAuthedUser
} from '../lib/supabase-admin.js';

/* =========================================
   REFERRAL BONUS ENGINE
   Called by api/admin.js when a deposit is approved.
   Pays 10% of the approved deposit to the referrer's Main Balance.
========================================= */

export async function awardReferralBonus(depositRequestId, depositedUserId, depositAmount) {
  try {
    if (!depositRequestId || !depositedUserId) {
      return { awarded: false, reason: 'missing_ids' };
    }

    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { awarded: false, reason: 'invalid_amount' };
    }

    // 1. Load the request and check the paid flag
    const { data: request, error: requestError } = await supabaseAdmin
      .from('financial_requests')
      .select('id, referral_bonus_paid')
      .eq('id', depositRequestId)
      .maybeSingle();

    if (requestError) throw requestError;
    if (!request) return { awarded: false, reason: 'request_not_found' };
    if (request.referral_bonus_paid) return { awarded: false, reason: 'already_paid' };

    // 2. Find who referred this user
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('referred_by')
      .eq('id', depositedUserId)
      .maybeSingle();

    if (profileError) throw profileError;

    const referrerId = profile?.referred_by;

    if (!referrerId || referrerId === depositedUserId) {
      return { awarded: false, reason: 'no_referrer' };
    }

    // 3. Calculate 10% cashback
    const bonus = Math.round(amount * 0.10 * 100) / 100;
    if (bonus <= 0) return { awarded: false, reason: 'zero_bonus' };

    // 4. Credit referrer's Main Balance AND write the ledger row atomically
    const { data: credited, error: creditError } = await supabaseAdmin.rpc(
      'credit_balance_with_transaction',
      {
        p_user_id: referrerId,
        p_amount: bonus,
        p_balance_type: 'main',
        p_tx_type: 'referral_bonus',
        p_description: '10% referral deposit cashback',
        p_reference_id: depositRequestId
      }
    );

    if (creditError) throw creditError;
    if (!credited) throw new Error('Unable to credit referrer balance');

    // 6. Mark as paid so it can never pay twice
    const { error: flagError } = await supabaseAdmin
      .from('financial_requests')
      .update({ referral_bonus_paid: true })
      .eq('id', depositRequestId);

    if (flagError) throw flagError;

    return { awarded: true, bonus, referrer_id: referrerId };
  } catch (err) {
    console.error('Referral bonus error:', err);
    return { awarded: false, error: err.message };
  }
}

/* =========================================
   HTTP HANDLER
   GET /api/referral?action=dashboard
========================================= */

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getAuthedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const action = req.query.action || 'dashboard';

    if (action === 'dashboard') {
      // 1. Own referral code
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('referral_code')
        .eq('id', user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      // 2. Everyone referred by this user
      const { data: referrals, error: referralsError } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, created_at')
        .eq('referred_by', user.id)
        .order('created_at', { ascending: false });

      if (referralsError) throw referralsError;

      const referralIds = (referrals || []).map(r => r.id);

      // 3. Approved deposits made by those referrals
      let approvedDepositCount = 0;
      let totalDepositAmount = 0;
      const statsByReferral = {};

      if (referralIds.length > 0) {
        const { data: deposits, error: depositsError } = await supabaseAdmin
          .from('financial_requests')
          .select('user_id, amount, status, created_at')
          .in('user_id', referralIds)
          .eq('type', 'deposit')
          .in('status', ['approved', 'pending']);

        if (depositsError) throw depositsError;

        for (const d of deposits || []) {
          const value = Number(d.amount);

          const s = statsByReferral[d.user_id] || (statsByReferral[d.user_id] = {
            approved_count: 0,
            approved_volume: 0,
            pending_count: 0,
            pending_volume: 0,
            last_deposit_at: null
          });

          if (!s.last_deposit_at || d.created_at > s.last_deposit_at) {
            s.last_deposit_at = d.created_at;
          }

          if (d.status === 'approved') {
            s.approved_count += 1;
            s.approved_volume += value;
            approvedDepositCount += 1;
            totalDepositAmount += value;
          } else {
            s.pending_count += 1;
            s.pending_volume += value;
          }
        }
      }

      // 4. Total bonus this user has earned
      const { data: bonusTransactions, error: bonusError } = await supabaseAdmin
        .from('transactions')
        .select('amount')
        .eq('user_id', user.id)
        .eq('type', 'referral_bonus');

      if (bonusError) throw bonusError;

      const totalBonusEarned =
        bonusTransactions?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;

      // 5. Build absolute referral link (fixes missing domain)
      const baseUrl =
        process.env.PUBLIC_SITE_URL ||
        (req.headers.host ? `https://${req.headers.host}` : '') ||
        req.headers.origin ||
        '';

      return res.status(200).json({
        success: true,
        referral_code: profile?.referral_code || '',
        referral_link: `${baseUrl}/register.html?ref=${profile?.referral_code || ''}`,
        summary: {
          total_referrals: referrals?.length || 0,
          approved_deposits: approvedDepositCount,
          total_deposit_amount: Math.round(totalDepositAmount * 100) / 100,
          total_bonus_earned: Math.round(totalBonusEarned * 100) / 100
        },
        referrals: (referrals || []).map(r => {
          const s = statsByReferral[r.id] || {
            approved_count: 0,
            approved_volume: 0,
            pending_count: 0,
            pending_volume: 0,
            last_deposit_at: null
          };

          return {
            id: r.id,
            full_name: r.full_name,
            created_at: r.created_at,
            has_deposited: s.approved_count > 0,
            approved_deposit_count: s.approved_count,
            approved_deposit_volume: Math.round(s.approved_volume * 100) / 100,
            pending_deposit_count: s.pending_count,
            pending_deposit_volume: Math.round(s.pending_volume * 100) / 100,
            last_deposit_at: s.last_deposit_at
          };
        })
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Referral API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
