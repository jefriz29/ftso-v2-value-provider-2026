import { Logger } from '@nestjs/common';
import { FeedId, FeedValueData, FeedVolumeData } from '../dto/provider-requests.dto';
import { BaseDataFeed } from './base-feed';
import { CcxtFeed } from './ccxt-provider-service';
import { FtsoFeedV1 } from './ftso-feed-v1';
import { WebSocketPriceService } from './websocket-price-service';
import { calculateMedianPrice, FlareMedianMonitor, PriceObservation } from './flare-median-monitor';

import prodFeeds from '../config/feeds.json';
import testFeeds from '../config/test-feeds.json';

type PriceSource = 'ftso-v1' | 'ftso-websocket' | 'ccxt';
type FinalPriceSource = PriceSource | 'median' | 'last-good' | 'unavailable';

export interface CombinedPriceResult {
  value: number | undefined;
  source: FinalPriceSource;
  v1DeviationPct?: number;
  websocketDeviationPct?: number;
  selectedDeviationPct?: number;
  nearCcxt?: boolean;
}

/** Percent points: +0.1 increases the selected price by 0.1%. */
export interface FinalPriceConfig {
  source?: 'ccxt' | 'v1' | 'socket' | 0;
  adjustedDeviation?: number;
}

export function validateFinalPriceConfig(config: FinalPriceConfig): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('finalPrice must be an object');
  if (config.source !== undefined && !['ccxt', 'v1', 'socket', 0].includes(config.source)) {
    throw new Error('finalPrice.source must be ccxt, v1, socket or 0');
  }
  if (
    config.adjustedDeviation !== undefined &&
    (typeof config.adjustedDeviation !== 'number' ||
      !Number.isFinite(config.adjustedDeviation) ||
      config.adjustedDeviation <= -100)
  ) {
    throw new Error('finalPrice.adjustedDeviation must be finite and greater than -100');
  }
}

export function selectConfiguredPrice(
  v1: number | undefined,
  socket: number | undefined,
  ccxt: number | undefined,
  nearLimit = 0.2,
  config?: FinalPriceConfig,
): CombinedPriceResult {
  const automatic = selectCombinedPrice(v1, socket, ccxt, nearLimit);
  if (config === undefined) return automatic;
  validateFinalPriceConfig(config);
  const requested =
    config.source === 'ccxt' ? ccxt : config.source === 'v1' ? v1 : config.source === 'socket' ? socket : undefined;
  const requestedValue = validPrice(requested);
  const selected: CombinedPriceResult =
    requestedValue === undefined
      ? automatic
      : {
          ...automatic,
          value: requestedValue,
          source: config.source === 'v1' ? 'ftso-v1' : config.source === 'socket' ? 'ftso-websocket' : 'ccxt',
        };
  // Adjust only live prices. Last-good caching happens afterwards, avoiding repeated adjustment.
  const value = selected.value === undefined ? undefined : selected.value * (1 + (config.adjustedDeviation ?? 0) / 100);
  const reference = validPrice(ccxt);
  const deviation = value === undefined || reference === undefined ? undefined : percentageDeviation(value, reference);
  return {
    ...selected,
    value: validPrice(value),
    selectedDeviationPct: deviation,
    nearCcxt: deviation === undefined ? undefined : deviation <= nearLimit,
  };
}

export interface CachedPrice {
  value: number;
  savedAtMs: number;
}

export function resolveWithLastGoodPrice(
  cache: Map<string, CachedPrice>,
  key: string,
  selected: CombinedPriceResult,
  maxAgeMs: number,
  nowMs = Date.now(),
): { result: CombinedPriceResult; cacheAgeMs?: number } {
  const freshValue = validPrice(selected.value);
  if (freshValue !== undefined) {
    cache.set(key, { value: freshValue, savedAtMs: nowMs });
    return { result: selected };
  }

  const cached = cache.get(key);
  if (cached === undefined) return { result: selected };

  const cacheAgeMs = nowMs - cached.savedAtMs;
  if (cacheAgeMs > maxAgeMs) {
    cache.delete(key);
    return { result: selected };
  }

  return { result: { value: cached.value, source: 'last-good' }, cacheAgeMs };
}

/**
 * Chooses a custom-provider price using CCXT as the reference.
 * CCXT is not selected while either custom price is available.
 */
export function selectCombinedPrice(
  v1Price: number | undefined,
  websocketPrice: number | undefined,
  ccxtPrice: number | undefined,
  nearCcxtMaxDeviationPct = 0.2,
): CombinedPriceResult {
  const v1 = validPrice(v1Price);
  const websocket = validPrice(websocketPrice);
  const ccxt = validPrice(ccxtPrice);

  if (ccxt !== undefined && (v1 !== undefined || websocket !== undefined)) {
    const v1DeviationPct = v1 === undefined ? undefined : percentageDeviation(v1, ccxt);
    const websocketDeviationPct = websocket === undefined ? undefined : percentageDeviation(websocket, ccxt);

    if (v1 === undefined) {
      return {
        value: websocket,
        source: 'ftso-websocket',
        websocketDeviationPct,
        selectedDeviationPct: websocketDeviationPct,
        nearCcxt: websocketDeviationPct <= nearCcxtMaxDeviationPct,
      };
    }
    if (websocket === undefined) {
      return {
        value: v1,
        source: 'ftso-v1',
        v1DeviationPct,
        selectedDeviationPct: v1DeviationPct,
        nearCcxt: v1DeviationPct <= nearCcxtMaxDeviationPct,
      };
    }

    // Prefer the direct WebSocket value when it is already near CCXT. It is
    // usually the freshest and retains more precision than rounded API data.
    if (websocketDeviationPct <= nearCcxtMaxDeviationPct) {
      return {
        value: websocket,
        source: 'ftso-websocket',
        v1DeviationPct,
        websocketDeviationPct,
        selectedDeviationPct: websocketDeviationPct,
        nearCcxt: true,
      };
    }

    if (websocketDeviationPct < v1DeviationPct) {
      return {
        value: websocket,
        source: 'ftso-websocket',
        v1DeviationPct,
        websocketDeviationPct,
        selectedDeviationPct: websocketDeviationPct,
        nearCcxt: false,
      };
    }
    return {
      value: v1,
      source: 'ftso-v1',
      v1DeviationPct,
      websocketDeviationPct,
      selectedDeviationPct: v1DeviationPct,
      nearCcxt: v1DeviationPct <= nearCcxtMaxDeviationPct,
    };
  }

  if (v1 !== undefined && websocket !== undefined) {
    return { value: (v1 + websocket) / 2, source: 'median' };
  }
  if (v1 !== undefined) return { value: v1, source: 'ftso-v1' };
  if (websocket !== undefined) return { value: websocket, source: 'ftso-websocket' };
  if (ccxt !== undefined) return { value: ccxt, source: 'ccxt' };
  return { value: undefined, source: 'unavailable' };
}

/**
 * Compares FTSO V1/API and direct WebSocket prices with one shared CCXT
 * reference, then returns the custom price nearest to CCXT.
 */
export class FtsoFeedCombined implements BaseDataFeed {
  private readonly logger = new Logger(FtsoFeedCombined.name);
  private readonly ccxt = new CcxtFeed();
  private readonly v1 = new FtsoFeedV1(this.ccxt, false, false);
  private readonly websocket = new WebSocketPriceService();
  private readonly flareMedianMonitor = new FlareMedianMonitor();
  private readonly finalPriceByFeed = new Map<string, FinalPriceConfig>(
    (
      (process.env.NETWORK === 'local-test' ? testFeeds : prodFeeds) as {
        feed: FeedId;
        finalPrice?: FinalPriceConfig;
      }[]
    )
      .filter((item) => item.finalPrice !== undefined)
      .map((item) => {
        validateFinalPriceConfig(item.finalPrice);
        return [feedKey(item.feed), item.finalPrice];
      }),
  );
  private readonly lastGoodPrices = new Map<string, CachedPrice>();
  private readonly lastGoodPriceMaxAgeMs = positiveIntegerFromEnv('LAST_GOOD_PRICE_MAX_AGE_MS', 30_000);
  private readonly nearCcxtMaxDeviationPct = positiveNumberFromEnv('NEAR_CCXT_MAX_DEVIATION_PCT', 0.2);

  async start(): Promise<void> {
    await this.ccxt.start();
    await this.v1.start();
    this.websocket.start();
    this.logger.log('Combined provider initialized; V1, direct WebSocket and CCXT comparison enabled');
  }

  async getValue(feed: FeedId): Promise<FeedValueData> {
    return (await this.getValues([feed]))[0];
  }

  async getValues(feeds: FeedId[]): Promise<FeedValueData[]> {
    return this.getValuesInternal(feeds);
  }

  async getValuesForRound(feeds: FeedId[], votingRoundId: number): Promise<FeedValueData[]> {
    return this.getValuesInternal(feeds, votingRoundId);
  }

  private async getValuesInternal(feeds: FeedId[], votingRoundId?: number): Promise<FeedValueData[]> {
    // V1 batches all CoinGecko-configured feeds into one request. The direct
    // WebSocket path deliberately bypasses its V1/CCXT fallback so the three
    // values remain independent observations instead of duplicated fallbacks.
    const [v1Result, websocketResult, ccxtResult] = await Promise.allSettled([
      this.v1.getValues(feeds),
      Promise.resolve(this.getDirectWebSocketValues(feeds)),
      this.ccxt.getValues(feeds),
    ]);

    const v1ByKey = valuesByFeed(v1Result.status === 'fulfilled' ? v1Result.value : []);
    const websocketByKey = valuesByFeed(websocketResult.status === 'fulfilled' ? websocketResult.value : []);
    const ccxtByKey = valuesByFeed(ccxtResult.status === 'fulfilled' ? ccxtResult.value : []);

    const observations: PriceObservation[] = [];
    const values = feeds.map((feed) => {
      const key = feedKey(feed);
      const v1Price = v1ByKey.get(key);
      const websocketPrice = websocketByKey.get(key);
      const ccxtPrice = ccxtByKey.get(key);
      const liveSelection = selectConfiguredPrice(
        v1Price,
        websocketPrice,
        ccxtPrice,
        this.nearCcxtMaxDeviationPct,
        this.finalPriceByFeed.get(key),
      );
      const selected = this.useLastGoodPrice(key, liveSelection);
      const localMedian = calculateMedianPrice([v1Price, websocketPrice, ccxtPrice]);

      observations.push({
        feed,
        v1: v1Price,
        websocket: websocketPrice,
        ccxt: ccxtPrice,
        selected: selected.value,
        selectedSource: selected.source,
        localMedian,
      });

      this.logger.log(
        `Combined price for ${feed.name}: selected=${selected.value ?? 'unavailable'} source=${selected.source} ` +
          `configuredSource=${this.finalPriceByFeed.get(key)?.source ?? 'default'} adjustedDeviation=${this.finalPriceByFeed.get(key)?.adjustedDeviation ?? 0} ` +
          `v1=${v1Price ?? 'unavailable'} websocket=${websocketPrice ?? 'unavailable'} ccxt=${ccxtPrice ?? 'unavailable'} ` +
          `v1DeviationPct=${formatDeviation(selected.v1DeviationPct)} ` +
          `websocketDeviationPct=${formatDeviation(selected.websocketDeviationPct)} ` +
          `selectedDeviationPct=${formatDeviation(selected.selectedDeviationPct)} ` +
          `nearCcxt=${selected.nearCcxt ?? 'n/a'} nearLimitPct=${this.nearCcxtMaxDeviationPct.toFixed(6)}`,
      );

      return { feed, value: selected.value };
    });

    if (votingRoundId !== undefined) this.flareMedianMonitor.schedule(votingRoundId, observations);
    return values;
  }

  async getVolumes(feeds: FeedId[], volumeWindow: number): Promise<FeedVolumeData[]> {
    return this.ccxt.getVolumes(feeds, volumeWindow);
  }

  private getDirectWebSocketValues(feeds: FeedId[]): FeedValueData[] {
    return feeds.map((feed) => {
      const direct = this.websocket.getMedian(feed);
      if (direct === undefined) return { feed, value: undefined };

      this.logger.debug(
        `Direct WebSocket price for ${feed.name}: ${direct.value} ` +
          `sources=${direct.sources.join(',')} newestAgeMs=${direct.newestAgeMs}`,
      );
      return { feed, value: direct.value };
    });
  }

  private useLastGoodPrice(key: string, selected: CombinedPriceResult): CombinedPriceResult {
    const resolved = resolveWithLastGoodPrice(this.lastGoodPrices, key, selected, this.lastGoodPriceMaxAgeMs);
    if (resolved.result.source === 'last-good') {
      this.logger.warn(`All live prices unavailable for ${key}; using last-good price ageMs=${resolved.cacheAgeMs}`);
    }
    return resolved.result;
  }
}

function validPrice(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function percentageDeviation(value: number, reference: number): number {
  return (Math.abs(value - reference) / reference) * 100;
}

function valuesByFeed(values: FeedValueData[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of values) {
    const price = validPrice(item.value);
    if (price !== undefined) result.set(feedKey(item.feed), price);
  }
  return result;
}

function feedKey(feed: FeedId): string {
  return `${feed.category}:${feed.name}`;
}

function formatDeviation(value: number | undefined): string {
  return value === undefined ? 'n/a' : value.toFixed(6);
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
