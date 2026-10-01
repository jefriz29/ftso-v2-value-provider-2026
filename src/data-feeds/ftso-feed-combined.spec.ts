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

import { selectConfiguredPrice } from './ftso-feed-combined';

describe('per-feed final price', () => {
  it.each([
    ['ccxt', 100],
    ['v1', 101],
    ['socket', 102],
  ] as const)('uses requested %s source even when another is closer', (source, value) => {
    expect(selectConfiguredPrice(101, 102, 100, 0.2, { source }).value).toBe(value);
  });
  it('falls back from zero selected source to custom price nearest CCXT', () => {
    expect(selectConfiguredPrice(0, 102, 100, 0.2, { source: 'v1' })).toMatchObject({
      value: 102,
      source: 'ftso-websocket',
    });
  });
  it('falls back to CCXT when custom sources are zero', () => {
    expect(selectConfiguredPrice(0, 0, 100, 0.2, { source: 'socket' }).value).toBe(100);
  });
  it('keeps the old behavior without settings', () => {
    expect(selectConfiguredPrice(101, 102, 100)).toEqual(selectCombinedPrice(101, 102, 100));
  });
  it.each([0.1, -0.1, 0])('applies signed percent adjustment %s once', (adjustedDeviation) => {
    expect(selectConfiguredPrice(0, 0, 100, 0.2, { source: 'ccxt', adjustedDeviation }).value).toBeCloseTo(
      100 + adjustedDeviation,
    );
  });
  it('does not create a price when all sources are missing', () => {
    expect(selectConfiguredPrice(0, 0, 0, 0.2, { adjustedDeviation: 1 }).value).toBeUndefined();
  });
  it.each([-100, NaN, Infinity])('rejects invalid adjustment %s', (adjustedDeviation) => {
    expect(() => selectConfiguredPrice(1, 1, 1, 0.2, { adjustedDeviation })).toThrow();
  });
});

describe('independent optional finalPrice settings', () => {
  it('adjusts default selection when only adjustedDeviation is set', () => {
    expect(selectConfiguredPrice(101, 105, 100, 0.2, { adjustedDeviation: 1 })).toMatchObject({
      value: 102.01,
      source: 'ftso-v1',
    });
  });
  it('leaves default selection unchanged with empty settings or zero adjustment', () => {
    for (const config of [{}, { adjustedDeviation: 0 }]) {
      expect(selectConfiguredPrice(101, 105, 100, 0.2, config)).toMatchObject({ value: 101, source: 'ftso-v1' });
    }
  });
});
