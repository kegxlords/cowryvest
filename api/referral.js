// api/referral.js
import {
  supabaseAdmin,
  getAuthedUser
} from '../lib/supabase-admin.js';

export async function awardReferralBonus(depositRequestId, depositedUserId, depositAmount) {
  try {
    const { data: request, error: requestError } = await supabaseAdmin
      .from('financial_requests')
      .select('referral_bonus_paid')
      .eq('id', depositRequestId)
      .maybeSingle();

    if (requestError) throw requestError;
    if (!request || request.referral_bonus_paid) {
      return { awarded: false, reason: 'already_paid_or_missing' };
    }

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

    const bonus = Math.round(Number(depositAmount) * 0.10 * 100) / 100;

    if (bonus <= 0) {
      return { awarded: false, reason: 'zero_bonus' };
    }

    const { error: creditError } = await supabaseAdmin.rpc('credit_balance', {
      p_user_id: referrerId,
      p_amount: bonus,
      p_balance_type: 'main'
    });

    if (creditError) throw creditError;

    await supabaseAdmin.from('transactions').insert({
      user_id: referrerId,
      type: 'referral_bonus',
      amount: bonus,
      balance_type: 'main',
      status: 'completed',
      description: '10% referral deposit cashback',
      reference_id: depositRequestId
    });

    await supabaseAdmin
      .from('financial_requests')
      .update({ referral_bonus_paid: true })
      .eq('id', depositRequestId);

    return { awarded: true, bonus, referrer_id: referrerId };
  } catch (err) {
    console.error('Referral bonus error:', err);
    return { awarded: false, error: err.message };
  }
}

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
      const { data: profile, error: profileError } = await supabaseAdmin
        .from('profiles')
        .select('referral_code, main_balance')
        .eq('id', user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      const { data: referrals, error: referralsError } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, created_at')
        .eq('referred_by', user.id)
        .order('created_at', { ascending: false });

      if (referralsError) throw referralsError;

      const referralIds = (referrals || []).map(r => r.id);

      let totalDepositAmount = 0;
      let approvedDepositCount = 0;

      if (referralIds.length > 0) {
        const { data: approvedDeposits, error: depositsError } = await supabaseAdmin
          .from('financial_requests')
          .select('amount')
          .in('user_id', referralIds)
          .eq('type', 'deposit')
          .eq('status', 'approved');

        if (depositsError) throw depositsError;

        approvedDepositCount = approvedDeposits?.length || 0;
        totalDepositAmount =
          approvedDeposits?.reduce((sum, d) => sum + Number(d.amount), 0) || 0;
      }

      const { data: bonusTransactions, error: bonusError } = await supabaseAdmin
        .from('transactions')
        .select('amount')
        .eq('user_id', user.id)
        .eq('type', 'referral_bonus');

      if (bonusError) throw bonusError;

      const totalBonusEarned =
        bonusTransactions?.reduce((sum, t) => sum + Number(t.amount), 0) || 0;

      return res.status(200).json({
        success: true,
        referral_code: profile?.referral_code || '',
      const baseUrl =
        process.env.APP_URL ||
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
        referrals: referrals || []
      });
      summary: {
          total_referrals: referrals?.length || 0,
          approved_deposits: approvedDepositCount,
          total_deposit_amount: Math.round(totalDepositAmount * 100) / 100,
          total_bonus_earned: Math.round(totalBonusEarned * 100) / 100
        },
        referrals: referrals || []
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Referral API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
