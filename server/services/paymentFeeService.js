/** @typedef {'byoc' | 'match'} AgreementSource */
/** @typedef {'byoc_platform_fee' | 'match_fee'} FeeType */

const BYOC_FEE_PERCENT = 5;
const MATCH_FEE_PERCENT = 10;

/**
 * @param {AgreementSource} source
 * @returns {number}
 */
export function getFeePercentForAgreement(source) {
  return source === 'match' ? MATCH_FEE_PERCENT : BYOC_FEE_PERCENT;
}

/**
 * @param {AgreementSource} source
 * @returns {FeeType}
 */
export function getFeeTypeForSource(source) {
  return source === 'match' ? 'match_fee' : 'byoc_platform_fee';
}

/**
 * Persisted on household_cleaner_agreements when an agreement is created.
 * @param {AgreementSource} source
 * @returns {{ fee_type: FeeType, fee_percent: number }}
 */
export function feeFieldsForAgreementSource(source) {
  return {
    fee_type: getFeeTypeForSource(source),
    fee_percent: getFeePercentForAgreement(source),
  };
}

/**
 * Platform fee on cleaner amount; homeowner pays cleaner + fee.
 *
 * @param {{ cleanerAmountCents: number, source: AgreementSource }} params
 * @returns {{
 *   cleaner_amount_cents: number,
 *   bradley_fee_cents: number,
 *   total_amount_cents: number,
 *   fee_type: FeeType,
 *   fee_percent: number,
 * }}
 */
export function calculatePaymentBreakdown({ cleanerAmountCents, source }) {
  if (!Number.isInteger(cleanerAmountCents) || cleanerAmountCents < 0) {
    throw new Error('cleanerAmountCents must be a non-negative integer');
  }
  if (source !== 'byoc' && source !== 'match') {
    throw new Error('source must be byoc or match');
  }

  const fee_percent = getFeePercentForAgreement(source);
  const bradley_fee_cents = Math.round((cleanerAmountCents * fee_percent) / 100);

  return {
    cleaner_amount_cents: cleanerAmountCents,
    bradley_fee_cents,
    total_amount_cents: cleanerAmountCents + bradley_fee_cents,
    fee_type: getFeeTypeForSource(source),
    fee_percent,
  };
}
