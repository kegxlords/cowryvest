// api/wealth.js
import {
  supabaseAdmin,
  getAuthedUser,
  getBody,
  parseAmount
} from '../lib/supabase-admin.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
// =====================================
    // GET ENDPOINTS
    // =====================================
    if (req.method === 'GET') {
      const action = req.query.action;

      // -------------------------------------
      // STOCKS LIST
      // GET /api/wealth?action=stocks
      // -------------------------------------
      if (action === 'stocks') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        const { data, error } = await supabaseAdmin
          .from('stocks')
          .select('id, company_name, symbol, current_price, updated_at')
          .order('company_name', { ascending: true });

        if (error) throw error;

        return res.status(200).json({ success: true, stocks: data || [] });
      }

      // -------------------------------------
      // USER HOLDINGS
      // GET /api/wealth?action=holdings
      // -------------------------------------
      if (action === 'holdings') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        const { data, error } = await supabaseAdmin
          .from('user_stocks')
          .select(`
            id,
            stock_id,
            quantity,
            total_initial_invested,
            purchase_source,
            lock_in_days,
            created_at,
            stocks (
              company_name,
              symbol,
              current_price
            )
          `)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (error) throw error;

        return res.status(200).json({ success: true, holdings: data || [] });
      }

      // -------------------------------------
      // MIDNIGHT CRON
      // Vercel calls GET /api/wealth with NO action param
      // -------------------------------------
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized cron access' });
      }

    // =====================================
    // USER ACTIONS
    // POST /api/wealth
    // =====================================
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const user = await getAuthedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const body = getBody(req);
    const action = body.action;

    // -------------------------------------
    // BUY STOCK
    // -------------------------------------
    if (action === 'buy') {
      const stockId = body.stock_id;
      const quantity = parseInt(body.quantity, 10);
      const purchaseSource = body.purchase_source;

      if (!stockId) {
        return res.status(400).json({ error: 'Stock ID is required' });
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: 'Quantity must be greater than zero' });
      }

      if (!['main', 'frozen'].includes(purchaseSource)) {
        return res.status(400).json({ error: 'Invalid purchase source' });
      }

      const { data: stock, error: stockError } = await supabaseAdmin
        .from('stocks')
        .select('id, company_name, current_price')
        .eq('id', stockId)
        .maybeSingle();

      if (stockError) throw stockError;
      if (!stock) {
        return res.status(404).json({ error: 'Stock not found' });
      }

      const totalCost = Math.round(Number(stock.current_price) * quantity * 100) / 100;

      // Deduct balance safely
      const { data: debitSuccess, error: debitError } = await supabaseAdmin.rpc(
        'debit_balance',
        {
          p_user_id: user.id,
          p_amount: totalCost,
          p_balance_type: purchaseSource
        }
      );

      if (debitError) throw debitError;

      if (!debitSuccess) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Check existing holding for same stock + same source
      const { data: existingHolding, error: existingError } = await supabaseAdmin
        .from('user_stocks')
        .select('*')
        .eq('user_id', user.id)
        .eq('stock_id', stockId)
        .eq('purchase_source', purchaseSource)
        .maybeSingle();

      if (existingError) {
        // Compensate debit
        await supabaseAdmin.rpc('credit_balance', {
          p_user_id: user.id,
          p_amount: totalCost,
          p_balance_type: purchaseSource
        });

        throw existingError;
      }

      let savedHolding = null;

      if (existingHolding) {
        // Additive lock-in logic:
        // existing lock-in days + newly bought quantity
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('user_stocks')
          .update({
            quantity: existingHolding.quantity + quantity,
            total_initial_invested:
              Number(existingHolding.total_initial_invested) + totalCost,
            lock_in_days: existingHolding.lock_in_days + quantity
          })
          .eq('id', existingHolding.id)
          .select()
          .maybeSingle();

        if (updateError) {
          await supabaseAdmin.rpc('credit_balance', {
            p_user_id: user.id,
            p_amount: totalCost,
            p_balance_type: purchaseSource
          });

          throw updateError;
        }

        savedHolding = updated;
      } else {
        const { data: inserted, error: insertError } = await supabaseAdmin
          .from('user_stocks')
          .insert({
            user_id: user.id,
            stock_id: stockId,
            quantity,
            total_initial_invested: totalCost,
            purchase_source: purchaseSource,
            lock_in_days: quantity
          })
          .select()
          .maybeSingle();

        if (insertError) {
          await supabaseAdmin.rpc('credit_balance', {
            p_user_id: user.id,
            p_amount: totalCost,
            p_balance_type: purchaseSource
          });

          throw insertError;
        }

        savedHolding = inserted;
      }

      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'stock_purchase',
        amount: totalCost,
        balance_type: purchaseSource,
        status: 'completed',
        description: `Bought ${quantity} shares of ${stock.company_name}`,
        reference_id: savedHolding?.id || null
      });

      return res.status(200).json({
        success: true,
        message: 'Stock purchased successfully',
        holding: savedHolding
      });
    }

    // -------------------------------------
    // SELL / CONVERT STOCK
    // -------------------------------------
    if (action === 'sell') {
      const userStockId = body.user_stock_id;

      if (!userStockId) {
        return res.status(400).json({ error: 'Holding ID is required' });
      }

      const { data: holding, error: holdingError } = await supabaseAdmin
        .from('user_stocks')
        .select(`
          id,
          user_id,
          stock_id,
          quantity,
          total_initial_invested,
          purchase_source,
          lock_in_days,
          stocks (
            company_name,
            current_price
          )
        `)
        .eq('id', userStockId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (holdingError) throw holdingError;
      if (!holding) {
        return res.status(404).json({ error: 'Holding not found' });
      }

      if (holding.lock_in_days > 0) {
        return res.status(400).json({
          error: `This position is locked for ${holding.lock_in_days} more day(s).`
        });
      }

      const currentPrice = Number(holding.stocks?.current_price || 0);
      const payout = Math.round(holding.quantity * currentPrice * 100) / 100;
      const destinationBalance = holding.purchase_source;

      const { error: creditError } = await supabaseAdmin.rpc('credit_balance', {
        p_user_id: user.id,
        p_amount: payout,
        p_balance_type: destinationBalance
      });

      if (creditError) throw creditError;

      const { error: deleteError } = await supabaseAdmin
        .from('user_stocks')
        .delete()
        .eq('id', holding.id);

      if (deleteError) {
        // Compensate credit if deletion fails
        await supabaseAdmin.rpc('debit_balance', {
          p_user_id: user.id,
          p_amount: payout,
          p_balance_type: destinationBalance
        });

        throw deleteError;
      }

      await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'stock_sale',
        amount: payout,
        balance_type: destinationBalance,
        status: 'completed',
        description: `Converted ${holding.quantity} shares of ${holding.stocks?.company_name || 'stock'}`,
        reference_id: holding.id
      });

      return res.status(200).json({
        success: true,
        message: 'Shares converted successfully',
        payout
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Wealth API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
