// api/finance.js
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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getAuthedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthenticated' });
    }

    const body = getBody(req);
    const action = body.action;

    // -------------------------------------
    // DEPOSIT REQUEST
    // -------------------------------------
    if (action === 'deposit_request') {
      const amount = parseAmount(body.amount);
      const paymentMethod = (body.payment_method || '').trim();
      const reference = (body.reference || '').trim();
      const proofUrl = (body.proof_url || '').trim();

      if (!amount) {
        return res.status(400).json({ error: 'Valid deposit amount is required' });
      }

      if (!paymentMethod) {
        return res.status(400).json({ error: 'Payment method is required' });
      }

      const { data: request, error } = await supabaseAdmin
        .from('financial_requests')
        .insert({
          user_id: user.id,
          type: 'deposit',
          amount,
          status: 'pending',
          payment_method: paymentMethod,
          reference: reference || null,
          proof_url: proofUrl || null
        })
        .select()
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({
        success: true,
        message: 'Deposit request submitted',
        request
      });
    }

    // -------------------------------------
    // WITHDRAWAL REQUEST
    // -------------------------------------
    if (action === 'withdraw_request') {
      const amount = parseAmount(body.amount);
      const destinationDetails = body.destination_details || {};

      if (!amount) {
        return res.status(400).json({ error: 'Valid withdrawal amount is required' });
      }

      if (
        !destinationDetails.account_name ||
        !destinationDetails.account_number
      ) {
        return res.status(400).json({
          error: 'Account name and account number/wallet address are required'
        });
      }

      // Deduct main balance immediately
      const { data: debitSuccess, error: debitError } = await supabaseAdmin.rpc(
        'debit_balance',
        {
          p_user_id: user.id,
          p_amount: amount,
          p_balance_type: 'main'
        }
      );

      if (debitError) throw debitError;

      if (!debitSuccess) {
        return res.status(400).json({ error: 'Insufficient main balance' });
      }

      const { data: request, error: requestError } = await supabaseAdmin
        .from('financial_requests')
        .insert({
          user_id: user.id,
          type: 'withdrawal',
          amount,
          status: 'pending',
          payment_method: destinationDetails.payment_method || 'bank',
          destination_details: destinationDetails
        })
        .select()
        .maybeSingle();

      if (requestError) {
        // Refund if request creation fails
        await supabaseAdmin.rpc('credit_balance', {
          p_user_id: user.id,
          p_amount: amount,
          p_balance_type: 'main'
        });

        throw requestError;
      }

      return res.status(200).json({
        success: true,
        message: 'Withdrawal request submitted',
        request
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Finance API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
