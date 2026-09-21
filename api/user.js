// api/user.js
import {
  supabaseAdmin,
  getAuthedUser
} from '../lib/supabase-admin.js';

const CREDIT_TRANSACTION_TYPES = [
  'stock_sale',
  'daily_yield',
  'referral_bonus',
  'frozen_credit'
];

const TRANSACTION_LABELS = {
  stock_purchase: 'Stock Purchase',
  stock_sale: 'Stock Conversion',
  daily_yield: 'Daily 5% Yield',
  referral_bonus: 'Referral Bonus',
  frozen_credit: 'Frozen Balance Credit'
};

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

    const action = req.query.action || 'profile';

    // -------------------------------------
    // PROFILE
    // -------------------------------------
    if (action === 'profile') {
      const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select(`
          id,
          full_name,
          email,
          role,
          main_balance,
          frozen_balance,
          referral_code,
          created_at
        `)
        .eq('id', user.id)
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({ success: true, profile });
    }

    // -------------------------------------
    // HISTORY
    // -------------------------------------
    if (action === 'history') {
      const { data: transactions, error: txError } = await supabaseAdmin
        .from('transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(300);

      if (txError) throw txError;

      const { data: requests, error: reqError } = await supabaseAdmin
        .from('financial_requests')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(300);

      if (reqError) throw reqError;

      const mappedTransactions = (transactions || [])
        .filter(t => !['deposit', 'withdrawal'].includes(t.type))
        .map(t => ({
          id: t.id,
          source: 'transaction',
          category: t.type,
          label: TRANSACTION_LABELS[t.type] || t.type,
          amount: Number(t.amount),
          direction: CREDIT_TRANSACTION_TYPES.includes(t.type) ? 'credit' : 'debit',
          balance_type: t.balance_type,
          status: t.status || 'completed',
          description: t.description || '',
          created_at: t.created_at
        }));

      const mappedRequests = (requests || []).map(r => ({
        id: r.id,
        source: 'request',
        category: r.type,
        label: r.type === 'deposit' ? 'Deposit Request' : 'Withdrawal Request',
        amount: Number(r.amount),
        direction: r.type === 'deposit' ? 'credit' : 'debit',
        balance_type: 'main',
        status: r.status,
        description: r.payment_method || '',
        created_at: r.created_at
      }));

      const history = [...mappedTransactions, ...mappedRequests].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );

      return res.status(200).json({ success: true, history });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('User API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
