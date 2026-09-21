import { supabase } from '../../lib/supabase';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify Admin Role
  const authHeader = req.headers.authorization;
  const { data: { user } } = await supabase.auth.getUser(authHeader?.split(' ')[1]);
  if (!user) return res.status(401).json({ error: 'Unauthenticated' });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const { action, stock_id, new_price, target_user_id, credit_amount } = req.body;

  // ==========================================
  // 2. UPDATE STOCK PRICES (Midnight Market Update)
  // ==========================================
  if (action === 'update_price') {
    const { error } = await supabase
      .from('stocks')
      .update({ current_price: new_price, updated_at: new Date().toISOString() })
      .eq('id', stock_id);

    if (error) return res.status(500).json({ error: error.message });
    
    return res.status(200).json({ success: true, message: 'Stock price updated' });
  }

  // ==========================================
  // 3. CREDIT PROMOTERS (Frozen Balance)
  // ==========================================
  if (action === 'credit_frozen') {
    // Fetch current frozen balance
    const { data: targetProfile } = await supabase
      .from('profiles')
      .select('frozen_balance')
      .eq('id', target_user_id)
      .single();

    if (!targetProfile) return res.status(404).json({ error: 'User not found' });

    // Add to frozen balance
    const newFrozenBalance = parseFloat(targetProfile.frozen_balance) + parseFloat(credit_amount);
    await supabase
      .from('profiles')
      .update({ frozen_balance: newFrozenBalance })
      .eq('id', target_user_id);

    // Log the transaction
    await supabase.from('transactions').insert({
      user_id: target_user_id,
      type: 'frozen_credit',
      amount: credit_amount,
      balance_type: 'frozen',
      description: 'Promoter bonus credited by Admin'
    });

    return res.status(200).json({ success: true, message: 'Frozen balance credited successfully' });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
