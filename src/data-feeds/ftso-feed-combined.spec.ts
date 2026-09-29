import { CachedPrice, resolveWithLastGoodPrice, selectCombinedPrice } from './ftso-feed-combined';

describe('selectCombinedPrice', () => {
  it('selects the V1 price when it is nearer to CCXT', () => {
    expect(selectCombinedPrice(101, 105, 100)).toMatchObject({ value: 101, source: 'ftso-v1' });
  });

  it('selects the WebSocket price when it is nearer to CCXT', () => {
    expect(selectCombinedPrice(95, 99, 100)).toMatchObject({ value: 99, source: 'ftso-websocket' });
  });

  it('keeps the more precise WebSocket value when it is near CCXT', () => {
    const result = selectCombinedPrice(0.0362, 0.036265000000000006, 0.0362);
    expect(result).toMatchObject({
      value: 0.036265000000000006,
      source: 'ftso-websocket',
      nearCcxt: true,
    });
    expect(result.selectedDeviationPct).toBeCloseTo(0.179558, 6);
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

describe('resolveWithLastGoodPrice', () => {
  it('uses a recent last-good value when every live source is unavailable', () => {
    const cache = new Map<string, CachedPrice>();
    resolveWithLastGoodPrice(cache, '1:HYPE/USD', { value: 88.25, source: 'ftso-v1' }, 30_000, 1_000);

    expect(
      resolveWithLastGoodPrice(cache, '1:HYPE/USD', { value: undefined, source: 'unavailable' }, 30_000, 20_000),
    ).toEqual({ result: { value: 88.25, source: 'last-good' }, cacheAgeMs: 19_000 });
  });

  it('does not use a last-good value after it expires', () => {
    const cache = new Map<string, CachedPrice>();
    resolveWithLastGoodPrice(cache, '1:LEO/USD', { value: 9.5, source: 'ccxt' }, 30_000, 1_000);

    expect(
      resolveWithLastGoodPrice(cache, '1:LEO/USD', { value: undefined, source: 'unavailable' }, 30_000, 31_001),
    ).toEqual({ result: { value: undefined, source: 'unavailable' } });
    expect(cache.size).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('never caches an invalid price: %s', (value) => {
    const cache = new Map<string, CachedPrice>();
    resolveWithLastGoodPrice(cache, '1:HYPE/USD', { value, source: 'unavailable' }, 30_000, 1_000);
    expect(cache.size).toBe(0);
  });
});
