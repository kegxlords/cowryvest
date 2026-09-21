// api/finance.js
import {
  supabaseAdmin,
  getAuthedUser,
  getBody,
  parseAmount
} from '../lib/supabase-admin.js';

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

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
    // Only amount, payment method, and depositor name required
    // -------------------------------------
    if (action === 'deposit_request') {
      const amount = parseAmount(body.amount);
      const paymentMethod = cleanText(body.payment_method, 80);
      const depositorName = cleanText(body.depositor_name, 120);

      if (!amount) {
        return res.status(400).json({ error: 'Valid deposit amount is required' });
      }

      if (!paymentMethod) {
        return res.status(400).json({ error: 'Payment method is required' });
      }

      if (!depositorName) {
        return res.status(400).json({ error: 'Name on deposit is required' });
      }

      const { data: request, error } = await supabaseAdmin
        .from('financial_requests')
        .insert({
          user_id: user.id,
          type: 'deposit',
          amount,
          status: 'pending',
          payment_method: paymentMethod,
          depositor_name: depositorName,
          destination_details: {
            depositor_name: depositorName
          }
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

      const accountName = cleanText(destinationDetails.account_name, 120);
      const accountNumber = cleanText(destinationDetails.account_number, 160);
      const bankName = cleanText(destinationDetails.bank_name, 120);
      const paymentMethod = cleanText(destinationDetails.payment_method, 80);

      if (!amount) {
        return res.status(400).json({ error: 'Valid withdrawal amount is required' });
      }

      if (!accountName || !accountNumber) {
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
          payment_method: paymentMethod || 'bank',
          destination_details: {
            payment_method: paymentMethod || 'bank',
            account_name: accountName,
            account_number: accountNumber,
            bank_name: bankName || null
          }
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
