import { Logger } from '@nestjs/common';
import { FeedId, FeedValueData, FeedVolumeData } from '../dto/provider-requests.dto';
import { BaseDataFeed } from './base-feed';
import { CcxtFeed } from './ccxt-provider-service';
import { FtsoFeedV1 } from './ftso-feed-v1';
import { WebSocketPriceService } from './websocket-price-service';

type PriceSource = 'ftso-v1' | 'ftso-websocket' | 'ccxt';

export interface CombinedPriceResult {
  value: number | undefined;
  source: PriceSource | 'median' | 'unavailable';
  v1DeviationPct?: number;
  websocketDeviationPct?: number;
}

/**
 * Chooses a custom-provider price using CCXT as the reference.
 * CCXT is not selected while either custom price is available.
 */
export function selectCombinedPrice(
  v1Price: number | undefined,
  websocketPrice: number | undefined,
  ccxtPrice: number | undefined,
): CombinedPriceResult {
  const v1 = validPrice(v1Price);
  const websocket = validPrice(websocketPrice);
  const ccxt = validPrice(ccxtPrice);

  if (ccxt !== undefined && (v1 !== undefined || websocket !== undefined)) {
    const v1DeviationPct = v1 === undefined ? undefined : percentageDeviation(v1, ccxt);
    const websocketDeviationPct = websocket === undefined ? undefined : percentageDeviation(websocket, ccxt);

    if (v1 === undefined) return { value: websocket, source: 'ftso-websocket', websocketDeviationPct };
    if (websocket === undefined) return { value: v1, source: 'ftso-v1', v1DeviationPct };

    if (websocketDeviationPct < v1DeviationPct) {
      return { value: websocket, source: 'ftso-websocket', v1DeviationPct, websocketDeviationPct };
    }
    return { value: v1, source: 'ftso-v1', v1DeviationPct, websocketDeviationPct };
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
  private readonly v1 = new FtsoFeedV1(this.ccxt, false);
  private readonly websocket = new WebSocketPriceService();

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

    return feeds.map((feed) => {
      const key = feedKey(feed);
      const v1Price = v1ByKey.get(key);
      const websocketPrice = websocketByKey.get(key);
      const ccxtPrice = ccxtByKey.get(key);
      const selected = selectCombinedPrice(v1Price, websocketPrice, ccxtPrice);

      this.logger.log(
        `Combined price for ${feed.name}: selected=${selected.value ?? 'unavailable'} source=${selected.source} ` +
          `v1=${v1Price ?? 'unavailable'} websocket=${websocketPrice ?? 'unavailable'} ccxt=${ccxtPrice ?? 'unavailable'} ` +
          `v1DeviationPct=${formatDeviation(selected.v1DeviationPct)} ` +
          `websocketDeviationPct=${formatDeviation(selected.websocketDeviationPct)}`,
      );

      return { feed, value: selected.value };
    });
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
