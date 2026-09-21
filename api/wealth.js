import { supabase } from '../../lib/supabase'; // Adjust path to your lib folder

export default async function handler(req, res) {
  // ==========================================
  // 1. MIDNIGHT CRON JOB (Triggered by Vercel)
  // ==========================================
  if (req.query.action === 'midnight-cron') {
    // Verify Vercel Cron Secret for security
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      // 1. Fetch all active user stocks
      const { data: allStocks, error } = await supabase.from('user_stocks').select('*');
      if (error) throw error;

      // 2. Group by user to calculate total daily yield per user
      const userYields = {};
      for (const stock of allStocks) {
        const yieldAmount = stock.total_initial_invested * 0.05; // 5% of initial price
        if (!userYields[stock.user_id]) userYields[stock.user_id] = 0;
        userYields[stock.user_id] += yieldAmount;
      }

      // 3. Credit yields to Main Balance and log transactions
      for (const [userId, totalYield] of Object.entries(userYields)) {
        if (totalYield <= 0) continue;
        
        // Add to main balance
        await supabase.rpc('increment_balance', { 
          user_id: userId, 
          amount: totalYield, 
          balance_type: 'main' 
        }); // *See note below about RPC
        
        // Log transaction
        await supabase.from('transactions').insert({
          user_id: userId,
          type: 'daily_yield',
          amount: totalYield,
          balance_type: 'main',
          description: 'Daily 5% investment yield'
        });
      }

      // 4. Decrement lock-in days by 1 for all stocks where lock_in_days > 0
      await supabase
        .from('user_stocks')
        .update({ lock_in_days: supabase.rpc('decrement_lock_in') }) // Custom SQL function
        .gt('lock_in_days', 0);

      return res.status(200).json({ success: true, message: 'Midnight processing complete' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ==========================================
  // 2. BUY & SELL STOCKS (User Actions)
  // ==========================================
  if (req.method === 'POST') {
    const { action, stock_id, quantity, purchase_source, user_stock_id } = req.body;
    
    // Get authenticated user
    const authHeader = req.headers.authorization;
    const { data: { user } } = await supabase.auth.getUser(authHeader?.split(' ')[1]);
    if (!user) return res.status(401).json({ error: 'Unauthenticated' });

    // --- BUY STOCK ---
    if (action === 'buy') {
      const { data: stock } = await supabase.from('stocks').select('current_price').eq('id', stock_id).single();
      const totalCost = stock.current_price * quantity;

      // Check balance
      const balanceColumn = purchase_source === 'frozen' ? 'frozen_balance' : 'main_balance';
      const { data: profile } = await supabase.from('profiles').select(balanceColumn).eq('id', user.id).single();
      
      if (profile[balanceColumn] < totalCost) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Deduct balance
      await supabase.from('profiles').update({ [balanceColumn]: profile[balanceColumn] - totalCost }).eq('id', user.id);

      // Upsert into user_stocks (Handles the additive lock-in logic)
      const { data: existingHolding } = await supabase
        .from('user_stocks')
        .select('*')
        .eq('user_id', user.id)
        .eq('stock_id', stock_id)
        .eq('purchase_source', purchase_source)
        .single();

      if (existingHolding) {
        // Additive logic: Add shares, add initial cost, ADD days to lock-in
        await supabase.from('user_stocks').update({
          quantity: existingHolding.quantity + quantity,
          total_initial_invested: existingHolding.total_initial_invested + totalCost,
          lock_in_days: existingHolding.lock_in_days + quantity // Additive lock-in!
        }).eq('id', existingHolding.id);
      } else {
        // New holding
        await supabase.from('user_stocks').insert({
          user_id: user.id,
          stock_id: stock_id,
          quantity: quantity,
          total_initial_invested: totalCost,
          purchase_source: purchase_source,
          lock_in_days: quantity // Initial lock-in equals quantity bought
        });
      }

      // Log transaction
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'stock_purchase', amount: totalCost, 
        balance_type: purchase_source, description: `Bought ${quantity} shares`
      });

      return res.status(200).json({ success: true, message: 'Stock purchased successfully' });
    }

    // --- SELL / CONVERT STOCK ---
    if (action === 'sell') {
      const { data: holding } = await supabase.from('user_stocks').select('*, stocks(current_price)').eq('id', user_stock_id).eq('user_id', user.id).single();
      
      if (!holding) return res.status(404).json({ error: 'Holding not found' });
      if (holding.lock_in_days > 0) return res.status(400).json({ error: `Stock is locked for ${holding.lock_in_days} more days` });

      const payout = holding.quantity * holding.stocks.current_price;
      const destinationBalance = holding.purchase_source === 'frozen' ? 'frozen_balance' : 'main_balance';

      // Credit the correct balance
      const { data: profile } = await supabase.from('profiles').select(destinationBalance).eq('id', user.id).single();
      await supabase.from('profiles').update({ [destinationBalance]: profile[destinationBalance] + payout }).eq('id', user.id);

      // Delete the holding
      await supabase.from('user_stocks').delete().eq('id', user_stock_id);

      // Log transaction
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'stock_sale', amount: payout, 
        balance_type: holding.purchase_source, description: `Sold ${holding.quantity} shares`
      });

      return res.status(200).json({ success: true, message: 'Stock converted successfully' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
