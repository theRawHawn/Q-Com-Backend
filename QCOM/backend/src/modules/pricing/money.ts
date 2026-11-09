import BigNumber from 'bignumber.js';

// Configure BigNumber globally for financial precision
// 20 decimal places for intermediate operations to avoid precision loss
BigNumber.config({
  DECIMAL_PLACES: 20,
  ROUNDING_MODE: BigNumber.ROUND_HALF_UP,
  EXPONENTIAL_AT: [-10, 20],
});

export const CURRENCY_CODE = 'INR' as const;
export const CURRENCY_EXPONENT = 2;
export const ROUNDING_POLICY = 'ROUND_HALF_UP_2_DECIMALS' as const;

/**
 * Parses an input value safely into a BigNumber.
 * Rejects NaN, Infinity.
 */
export function toDecimal(val: string | number | BigNumber): BigNumber {
  if (val instanceof BigNumber) {
    if (val.isNaN() || !val.isFinite()) {
      throw new Error('Invalid financial numeric value: NaN or Infinite');
    }
    return val;
  }
  if (typeof val === 'number') {
    if (isNaN(val) || !isFinite(val)) {
      throw new Error('Invalid financial numeric value: NaN or Infinite');
    }
    return new BigNumber(val.toString());
  }
  const str = String(val).trim();
  if (str === '') {
    throw new Error('Invalid financial numeric value: Empty string');
  }
  const bn = new BigNumber(str);
  if (bn.isNaN() || !bn.isFinite()) {
    throw new Error(`Invalid financial numeric value: ${val}`);
  }
  return bn;
}

/**
 * Rounds a monetary BigNumber or numeric string to 2 decimal places using Indian statutory ROUND_HALF_UP.
 * Returns exact string formatted to 2 decimals (e.g., '100.00').
 *
 * Guaranteed Test Cases:
 *  0.005     -> '0.01'
 *  99.995    -> '100.00'
 *  33.333333 -> '33.33'
 *  66.666667 -> '66.67'
 *  999.999   -> '1000.00'
 */
export function roundCurrency(val: string | number | BigNumber): string {
  const bn = toDecimal(val);
  return bn.toFixed(CURRENCY_EXPONENT, BigNumber.ROUND_HALF_UP);
}

/**
 * Multiplies two values with full intermediate decimal precision.
 */
export function multiply(a: string | number | BigNumber, b: string | number | BigNumber): BigNumber {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Adds multiple monetary values preserving precision.
 */
export function add(...values: (string | number | BigNumber)[]): BigNumber {
  return values.reduce<BigNumber>((acc, v) => acc.plus(toDecimal(v)), new BigNumber(0));
}

/**
 * Subtracts values from a (a - b - c ...).
 */
export function subtract(a: string | number | BigNumber, ...values: (string | number | BigNumber)[]): BigNumber {
  return values.reduce<BigNumber>((acc, v) => acc.minus(toDecimal(v)), toDecimal(a));
}

/**
 * Divides a by b (a / b). Throws on division by zero.
 */
export function divide(a: string | number | BigNumber, b: string | number | BigNumber): BigNumber {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    throw new Error('Division by zero in financial calculation');
  }
  return toDecimal(a).dividedBy(divisor);
}

/**
 * Compares two values: returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compare(a: string | number | BigNumber, b: string | number | BigNumber): number {
  return toDecimal(a).comparedTo(toDecimal(b)) ?? 0;
}

/**
 * Maximum of two values.
 */
export function max(a: string | number | BigNumber, b: string | number | BigNumber): BigNumber {
  return BigNumber.max(toDecimal(a), toDecimal(b));
}

/**
 * Minimum of two values.
 */
export function min(a: string | number | BigNumber, b: string | number | BigNumber): BigNumber {
  return BigNumber.min(toDecimal(a), toDecimal(b));
}
