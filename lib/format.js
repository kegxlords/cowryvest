// lib/format.js
export const CURRENCY_SYMBOL = '₦';

export function formatMoney(value) {
  const num = Number(value || 0);

  return `${CURRENCY_SYMBOL}${num.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}
