// api/wealth.js
//
// ENDPOINTS:
//   GET  /api/wealth?action=stocks        -> listed stocks (authenticated)
//   GET  /api/wealth?action=holdings      -> user's holdings (authenticated)
//   GET  /api/wealth?action=stake_market  -> stocks + live up/down pools (authenticated)
//   GET  /api/wealth?action=my_stakes     -> user's stakes (authenticated)
//   GET  /api/wealth                       -> midnight cron (Vercel, Bearer CRON_SECRET)
//   POST /api/wealth { action: 'buy' }          -> purchase shares
//   POST /api/wealth { action: 'sell' }         -> convert unlocked shares
//   POST /api/wealth { action: 'place_stake' }  -> stake up/down on a stock
//
import {
  supabaseAdmin,
  getAuthedUser,
  getBody
} from '../lib/supabase-admin.js';

// Guarded once-per-day job. Uses try/catch (NOT .catch) because Supabase
// query builders are thenables without a .catch method.
async function runMidnightHeal() {
  try {
    await supabaseAdmin.rpc('process_midnight_yield');
  } catch (err) {
    console.error('Midnight self-heal failed:', err.message);
  }
}

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
      // -------------------------------------
      if (action === 'stocks') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        await runMidnightHeal();

        const { data, error } = await supabaseAdmin
          .from('stocks')
          .select('id, company_name, symbol, current_price, updated_at')
          .order('company_name', { ascending: true });

        if (error) throw error;

        return res.status(200).json({ success: true, stocks: data || [] });
      }

      // -------------------------------------
      // USER HOLDINGS
      // -------------------------------------
      if (action === 'holdings') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        await runMidnightHeal();

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
      // STAKE MARKET (stocks + live up/down pools)
      // -------------------------------------
      if (action === 'stake_market') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        await runMidnightHeal();

        const { data: stocks, error: stocksError } = await supabaseAdmin
          .from('stocks')
          .select('id, company_name, symbol, current_price, updated_at')
          .order('company_name', { ascending: true });

        if (stocksError) throw stocksError;

        const { data: pools, error: poolsError } = await supabaseAdmin
          .from('stakes')
          .select('stock_id, direction, amount')
          .eq('status', 'open');

        if (poolsError) throw poolsError;

        const poolMap = {};
        for (const p of pools || []) {
          const m = poolMap[p.stock_id] || (poolMap[p.stock_id] = {
            up_total: 0, down_total: 0, up_count: 0, down_count: 0
          });
          if (p.direction === 'up') { m.up_total += Number(p.amount); m.up_count += 1; }
          else { m.down_total += Number(p.amount); m.down_count += 1; }
        }

        const out = (stocks || []).map(s => ({
          ...s,
          pools: poolMap[s.id] || { up_total: 0, down_total: 0, up_count: 0, down_count: 0 }
        }));

        return res.status(200).json({ success: true, stocks: out });
      }

      // -------------------------------------
      // MY STAKES
      // -------------------------------------
      if (action === 'my_stakes') {
        const user = await getAuthedUser(req);
        if (!user) {
          return res.status(401).json({ error: 'Unauthenticated' });
        }

        const { data, error } = await supabaseAdmin
          .from('stakes')
          .select(`
            id, amount, direction, entry_price, balance_source,
            status, payout, settled_price, created_at, settled_at,
            stocks ( company_name, symbol, current_price )
          `)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) throw error;

        return res.status(200).json({ success: true, stakes: data || [] });
      }

      // -------------------------------------
      // MIDNIGHT CRON
      // Vercel Cron calls GET /api/wealth with NO action param
      // and header: Authorization: Bearer <CRON_SECRET>
      // -------------------------------------
      const authHeader = req.headers.authorization;
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized cron access' });
      }

      const { data: result, error: cronError } = await supabaseAdmin.rpc('process_midnight_yield');
      if (cronError) throw cronError;

      return res.status(200).json({
        success: true,
        message: 'Midnight processing complete',
        result
      });
    }

    // =====================================
    // POST ENDPOINTS
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

      const { data: debitSuccess, error: debitError } = await supabaseAdmin.rpc('debit_balance', {
        p_user_id: user.id,
        p_amount: totalCost,
        p_balance_type: purchaseSource
      });

      if (debitError) throw debitError;

      if (!debitSuccess) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const { data: existingHolding, error: existingError } = await supabaseAdmin
        .from('user_stocks')
        .select('*')
        .eq('user_id', user.id)
        .eq('stock_id', stockId)
        .eq('purchase_source', purchaseSource)
        .maybeSingle();

      if (existingError) {
        await supabaseAdmin.rpc('credit_balance', {
          p_user_id: user.id,
          p_amount: totalCost,
          p_balance_type: purchaseSource
        });
        throw existingError;
      }

      let savedHolding = null;

      if (existingHolding) {
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('user_stocks')
          .update({
            quantity: existingHolding.quantity + quantity,
            total_initial_invested: Number(existingHolding.total_initial_invested) + totalCost,
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

      const { error: txError } = await supabaseAdmin.from('transactions').insert({
        user_id: user.id,
        type: 'stock_purchase',
        amount: totalCost,
        balance_type: purchaseSource,
        status: 'completed',
        description: `Bought ${quantity} shares of ${stock.company_name}`,
        reference_id: savedHolding?.id || null
      });

      if (txError) throw txError;

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

      const { data: credited, error: creditError } = await supabaseAdmin.rpc(
        'credit_balance_with_transaction',
        {
          p_user_id: user.id,
          p_amount: payout,
          p_balance_type: destinationBalance,
          p_tx_type: 'stock_sale',
          p_description: `Converted ${holding.quantity} shares of ${holding.stocks?.company_name || 'stock'}`,
          p_reference_id: holding.id
        }
      );

      if (creditError) throw creditError;

      if (!credited) {
        return res.status(500).json({ error: 'Unable to credit payout' });
      }

      const { error: deleteError } = await supabaseAdmin
        .from('user_stocks')
        .delete()
        .eq('id', holding.id);

      if (deleteError) {
        await supabaseAdmin.rpc('debit_balance', {
          p_user_id: user.id,
          p_amount: payout,
          p_balance_type: destinationBalance
        });
        throw deleteError;
      }

      return res.status(200).json({
        success: true,
        message: 'Shares converted successfully',
        payout
      });
    }

    // -------------------------------------
    // PLACE STAKE
    // -------------------------------------
    if (action === 'place_stake') {
      const stockId = body.stock_id;
      const direction = body.direction;
      const amount = Number(body.amount);
      const source = body.balance_source || 'main';

      if (!stockId) {
        return res.status(400).json({ error: 'Stock ID is required' });
      }

      if (!['up', 'down'].includes(direction)) {
        return res.status(400).json({ error: 'Choose Up or Down' });
      }

      if (!['main', 'frozen'].includes(source)) {
        return res.status(400).json({ error: 'Invalid balance source' });
      }

      const { data: stake, error } = await supabaseAdmin.rpc('place_stake', {
        p_user_id: user.id,
        p_stock_id: stockId,
        p_amount: amount,
        p_direction: direction,
        p_source: source
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      return res.status(200).json({ success: true, message: 'Stake placed', stake });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Wealth API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
