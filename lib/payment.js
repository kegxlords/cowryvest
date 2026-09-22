// lib/payment.js
// Manual transfer destinations shown on the deposit page.
// Edit these values to your real accounts. Remove any method you don't use.

export const PAYMENT_METHODS = [
  {
    id: 'bank_transfer',
    label: 'Bank Transfer',
    note: 'Transfer the exact amount to the account below, then submit your deposit request using the name on the transfer.',
    details: [
      { label: 'Bank Name', value: 'Your Bank Name' },
      { label: 'Account Name', value: 'Your Account Name' },
      { label: 'Account Number', value: '0123456789' }
    ]
  }
];
