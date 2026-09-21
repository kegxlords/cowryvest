// api/admin.js
import {
  supabaseAdmin,
  requireAdmin,
  getBody,
  parseAmount
} from '../lib/supabase-admin.js';

import { awardReferralBonus } from './referral.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const adminCheck = await requireAdmin(req);
    if (!adminCheck.ok) {
      return res.status(adminCheck.status).json({ error: adminCheck.error });
    }

    const body = getBody(req);
    const action = body.action;

    // -------------------------------------
    // UPDATE STOCK PRICE
    // -------------------------------------
    if (action === 'update_price') {
      const stockId = body.stock_id;
      const newPrice = parseAmount(body.new_price);

      if (!stockId) {
        return res.status(400).json({ error: 'Stock ID is required' });
      }

      if (!newPrice) {
        return res.status(400).json({ error: 'Valid new price is required' });
      }

      const { error } = await supabaseAdmin
        .from('stocks')
        .update({
          current_price: newPrice,
          updated_at: new Date().toISOString()
        })
        .eq('id', stockId);

      if (error) throw error;

      return res.status(200).json({ success: true, message: 'Stock price updated' });
    }

    // -------------------------------------
    // CREDIT FROZEN BALANCE
    // -------------------------------------
    if (action === 'credit_frozen') {
      const targetUserId = body.target_user_id;
      const amount = parseAmount(body.credit_amount);

      if (!targetUserId) {
        return res.status(400).json({ error: 'Target user ID is required' });
      }

      if (!amount) {
        return res.status(400).json({ error: 'Valid credit amount is required' });
      }

      const { error: creditError } = await supabaseAdmin.rpc('credit_balance', {
        p_user_id: targetUserId,
        p_amount: amount,
        p_balance_type: 'frozen'
      });

      if (creditError) throw creditError;

      await supabaseAdmin.from('transactions').insert({
        user_id: targetUserId,
        type: 'frozen_credit',
        amount,
        balance_type: 'frozen',
        status: 'completed',
        description: 'Promoter frozen balance credited by admin'
      });

      return res.status(200).json({
        success: true,
        message: 'Frozen balance credited successfully'
      });
    }

    // -------------------------------------
    // APPROVE FINANCIAL REQUEST
    // -------------------------------------
    if (action === 'approve_financial_request') {
      const requestId = body.request_id;
      const adminNote = (body.admin_note || '').trim();

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
          message: 'Deposit approved'
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
          message: 'Withdrawal approved'
        });
      }

      return res.status(400).json({ error: 'Invalid request type' });
    }

    // -------------------------------------
    // REJECT FINANCIAL REQUEST
    // -------------------------------------
    if (action === 'reject_financial_request') {
      const requestId = body.request_id;
      const adminNote = (body.admin_note || '').trim();

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
        message: 'Request rejected'
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
