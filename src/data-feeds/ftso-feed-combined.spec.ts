import { selectCombinedPrice } from './ftso-feed-combined';

describe('selectCombinedPrice', () => {
  it('selects the V1 price when it is nearer to CCXT', () => {
    expect(selectCombinedPrice(101, 105, 100)).toMatchObject({ value: 101, source: 'ftso-v1' });
  });

  it('selects the WebSocket price when it is nearer to CCXT', () => {
    expect(selectCombinedPrice(95, 99, 100)).toMatchObject({ value: 99, source: 'ftso-websocket' });
  });

  it('uses the midpoint median of both custom values when CCXT is unavailable', () => {
    expect(selectCombinedPrice(98, 102, undefined)).toEqual({ value: 100, source: 'median' });
  });

  it('uses CCXT only when both custom values are unavailable', () => {
    expect(selectCombinedPrice(undefined, undefined, 100)).toEqual({ value: 100, source: 'ccxt' });
  });

  it.each(['HYPE/USD', 'LEO/USD'])('uses CCXT for %s when both custom sources return zero', () => {
    expect(selectCombinedPrice(0, 0, 100)).toEqual({ value: 100, source: 'ccxt' });
  });

  it('discards a zero V1 price and keeps a valid WebSocket candidate', () => {
    expect(selectCombinedPrice(0, 99, 100)).toMatchObject({
      value: 99,
      source: 'ftso-websocket',
      websocketDeviationPct: 1,
    });
  });

  it('discards a zero WebSocket price and keeps a valid V1 candidate', () => {
    expect(selectCombinedPrice(101, 0, 100)).toMatchObject({
      value: 101,
      source: 'ftso-v1',
      v1DeviationPct: 1,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('uses CCXT when custom prices are invalid: %s', (price) => {
    expect(selectCombinedPrice(price, price, 100)).toEqual({ value: 100, source: 'ccxt' });
  });

  it('returns unavailable when no source has a valid positive price', () => {
    expect(selectCombinedPrice(0, Number.NaN, undefined)).toEqual({ value: undefined, source: 'unavailable' });
  });
});
