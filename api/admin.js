// api/admin.js
import {
  supabaseAdmin,
  requireAdmin,
  getBody
} from '../lib/supabase-admin.js';

import { awardReferralBonus } from './referral.js';

function parsePositiveAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
}

function parseNonNegativeAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

function sanitizeSearch(value) {
  return String(value || '')
    .trim()
    .replace(/[(),%]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // =====================================
    // ADMIN GET ENDPOINTS
    // =====================================
    if (req.method === 'GET') {
      const adminCheck = await requireAdmin(req);
      if (!adminCheck.ok) {
        return res.status(adminCheck.status).json({ error: adminCheck.error });
      }

      const action = req.query.action || 'stats';

      // -------------------------------
      // PLATFORM STATS
      // -------------------------------
      if (action === 'stats') {
        const { data, error } = await supabaseAdmin.rpc('admin_platform_overview');
        if (error) throw error;

        return res.status(200).json({ success: true, stats: data });
      }

      // -------------------------------
      // LIST STOCKS
      // -------------------------------
      if (action === 'stocks') {
        const { data, error } = await supabaseAdmin
          .from('stocks')
          .select('*')
          .order('company_name', { ascending: true });

        if (error) throw error;

        return res.status(200).json({ success: true, stocks: data || [] });
      }

      // -------------------------------
      // SEARCH USERS
      // -------------------------------
      if (action === 'users') {
        const q = sanitizeSearch(req.query.q);

        let query = supabaseAdmin
          .from('profiles')
          .select(`
            id,
            full_name,
            email,
            referral_code,
            role,
            main_balance,
            frozen_balance,
            created_at
          `)
          .order('created_at', { ascending: false })
          .limit(20);

        if (q) {
          query = query.or(
            `full_name.ilike.%${q}%,email.ilike.%${q}%,referral_code.ilike.%${q}%`
          );
        }

        const { data, error } = await query;
        if (error) throw error;

        return res.status(200).json({ success: true, users: data || [] });
      }

      // -------------------------------
      // FINANCIAL REQUESTS
      // -------------------------------
      if (action === 'requests') {
        const type = req.query.type || 'all';
        const status = req.query.status || 'all';

        let query = supabaseAdmin
          .from('financial_requests')
          .select(`
            *,
            profiles (
              full_name,
              email
            )
          `)
          .order('created_at', { ascending: false })
          .limit(200);

        if (type !== 'all') {
          query = query.eq('type', type);
        }

        if (status !== 'all') {
          query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) throw error;

        return res.status(200).json({ success: true, requests: data || [] });
      }

      // -------------------------------
      // RECENT FROZEN CREDITS
      // -------------------------------
      if (action === 'frozen_credits') {
        const { data, error } = await supabaseAdmin
          .from('transactions')
          .select(`
            *,
            profiles (
              full_name,
              email
            )
          `)
          .eq('type', 'frozen_credit')
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;

        return res.status(200).json({ success: true, credits: data || [] });
      }

      return res.status(400).json({ error: 'Invalid admin action' });
    }

    // =====================================
    // ADMIN POST ENDPOINTS
    // =====================================
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const adminCheck = await requireAdmin(req);
    if (!adminCheck.ok) {
      return res.status(adminCheck.status).json({ error: adminCheck.error });
    }

    const body = getBody(req);
    const action = body.action;

    // -------------------------------
    // UPDATE STOCK PRICE (settles open stakes atomically in the same tx)
    // -------------------------------
    if (action === 'update_price') {
      const stockId = body.stock_id;
      const newPrice = parseNonNegativeAmount(body.new_price);

      if (!stockId) {
        return res.status(400).json({ error: 'Stock ID is required' });
      }

      if (newPrice === null) {
        return res.status(400).json({ error: 'Valid new price is required' });
      }

      const { data: settlement, error } = await supabaseAdmin.rpc('update_price_and_settle', {
        p_stock_id: stockId,
        p_new_price: newPrice
      });

      if (error) throw error;

      return res.status(200).json({
        success: true,
        message: 'Stock price updated and stakes settled',
        settlement
      });
    }

    // -------------------------------
    // CREATE STOCK
    // -------------------------------
    if (action === 'create_stock') {
      const companyName = String(body.company_name || '').trim();
      const symbol = String(body.symbol || '').trim().toUpperCase() || null;
      const price = parseNonNegativeAmount(body.current_price);

      if (!companyName) {
        return res.status(400).json({ error: 'Company name is required' });
      }

      if (price === null) {
        return res.status(400).json({ error: 'Valid current price is required' });
      }

      const { data, error } = await supabaseAdmin
        .from('stocks')
        .insert({
          company_name: companyName,
          symbol,
          current_price: price,
          updated_at: new Date().toISOString()
        })
        .select()
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({
        success: true,
        message: 'Stock created',
        stock: data
      });
    }

    // -------------------------------
    // CREDIT FROZEN BALANCE
    // -------------------------------
    if (action === 'credit_frozen') {
      const targetUserId = body.target_user_id;
      const amount = parsePositiveAmount(body.credit_amount);
      const note = String(body.note || '').trim();

      if (!targetUserId) {
        return res.status(400).json({ error: 'Target user is required' });
      }

      if (!amount) {
        return res.status(400).json({ error: 'Valid credit amount is required' });
      }

      const { data: credited, error: creditError } = await supabaseAdmin.rpc(
        'credit_balance',
        {
          p_user_id: targetUserId,
          p_amount: amount,
          p_balance_type: 'frozen'
        }
      );

      if (creditError) throw creditError;

      if (!credited) {
        return res.status(400).json({ error: 'Unable to credit frozen balance' });
      }

      await supabaseAdmin.from('transactions').insert({
        user_id: targetUserId,
        type: 'frozen_credit',
        amount,
        balance_type: 'frozen',
        status: 'completed',
        description: note || 'Promoter frozen balance credited by admin'
      });

      return res.status(200).json({
        success: true,
        message: 'Frozen balance credited successfully'
      });
    }

    // -------------------------------
    // APPROVE FINANCIAL REQUEST
    // -------------------------------
    if (action === 'approve_financial_request') {
      const requestId = body.request_id;
      const adminNote = String(body.admin_note || '').trim();

      if (!requestId) {
        return res.status(400).json({ error: 'Request ID is required' });
      }

      const { data: request, error: requestError } = await supabaseAdmin
        .from('financial_requests')
        .select('*')
        .eq('id', requestId)
        .maybeSingle();

      if (requestError) throw requestError;

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Request is not pending' });
      }

      if (request.type === 'deposit') {
        const { error: creditError } = await supabaseAdmin.rpc('credit_balance', {
          p_user_id: request.user_id,
          p_amount: Number(request.amount),
          p_balance_type: 'main'
        });

        if (creditError) throw creditError;

        await supabaseAdmin
          .from('financial_requests')
          .update({
            status: 'approved',
            admin_note: adminNote || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', request.id);

        await awardReferralBonus(request.id, request.user_id, request.amount);

        return res.status(200).json({
          success: true,
          message: 'Deposit approved and user balance credited'
        });
      }

      if (request.type === 'withdrawal') {
        await supabaseAdmin
          .from('financial_requests')
          .update({
            status: 'approved',
            admin_note: adminNote || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', request.id);

        return res.status(200).json({
          success: true,
          message: 'Withdrawal marked as approved'
        });
      }

      return res.status(400).json({ error: 'Invalid request type' });
    }

    // -------------------------------
    // REJECT FINANCIAL REQUEST
    // -------------------------------
    if (action === 'reject_financial_request') {
      const requestId = body.request_id;
      const adminNote = String(body.admin_note || '').trim();

      if (!requestId) {
        return res.status(400).json({ error: 'Request ID is required' });
      }

      const { data: request, error: requestError } = await supabaseAdmin
        .from('financial_requests')
        .select('*')
        .eq('id', requestId)
        .maybeSingle();

      if (requestError) throw requestError;

      if (!request) {
        return res.status(404).json({ error: 'Request not found' });
      }

      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Request is not pending' });
      }

      if (request.type === 'withdrawal') {
        const { error: refundError } = await supabaseAdmin.rpc('credit_balance', {
          p_user_id: request.user_id,
          p_amount: Number(request.amount),
          p_balance_type: 'main'
        });

        if (refundError) throw refundError;
      }

      await supabaseAdmin
        .from('financial_requests')
        .update({
          status: 'rejected',
          admin_note: adminNote || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', request.id);

      return res.status(200).json({
        success: true,
        message: request.type === 'withdrawal'
          ? 'Withdrawal rejected and amount refunded'
          : 'Deposit rejected'
      });
    }

    return res.status(400).json({ error: 'Invalid admin action' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
