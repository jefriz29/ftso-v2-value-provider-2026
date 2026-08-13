import { Logger } from '@nestjs/common';
import { FeedId, FeedValueData, FeedVolumeData } from '../dto/provider-requests.dto';
import { asError } from '../utils/error';
import { BaseDataFeed } from './base-feed';
import { CcxtFeed } from './ccxt-provider-service';

import prodFeeds from '../config/feeds.json';
import testFeeds from '../config/test-feeds.json';

interface ApiConfig {
  /** Set to 1 to use this API. Disabled feeds use CCXT directly. */
  enabled: number;
  /** Complete endpoint for this feed. */
  url: string;
  /** Dot-separated path to the numeric price in the JSON response. */
  pricePath: string;
  /** Optional headers. Values may reference environment variables as ${NAME}. */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface FeedConfig {
  feed: FeedId;
  api?: ApiConfig;
}

const DEFAULT_API_TIMEOUT_MS = 3_000;
const API_CACHE_TTL_MS = process.env.API_CACHE_TTL_MS ? parseInt(process.env.API_CACHE_TTL_MS) : 15_000;
const COINGECKO_HOSTS = new Set(['api.coingecko.com', 'pro-api.coingecko.com']);

interface CoinGeckoFeed {
  feed: FeedId;
  config: ApiConfig;
  id: string;
}

/**
 * API-primary feed provider with CCXT as its fallback.
 *
 * Feeds without an `api` block in feeds.json automatically use CCXT. This lets
 * API sources be introduced one feed at a time without making a missing or
 * unhealthy API prevent the provider from returning an available CCXT value.
 */
export class FtsoFeedV1 implements BaseDataFeed {
  private readonly logger = new Logger(FtsoFeedV1.name);
  private readonly ccxtFeed = new CcxtFeed();
  private readonly configByKey = new Map<string, FeedConfig>();
  private coinGeckoCache: { expiresAt: number; prices: Map<string, number> } | undefined;

  async start(): Promise<void> {
    const config = this.loadConfig();
    for (const item of config) {
      this.configByKey.set(this.feedKey(item.feed), item);
    }

    await this.ccxtFeed.start();

    const apiFeedCount = config.filter((item) => this.isApiEnabled(item.api)).length;
    this.logger.log(`Initialized ${config.length} feeds (${apiFeedCount} API-primary, CCXT fallback enabled)`);
  }

  async getValue(feed: FeedId): Promise<FeedValueData> {
    const apiConfig = this.configByKey.get(this.feedKey(feed))?.api;

    if (this.isApiEnabled(apiConfig)) {
      try {
        const value = await this.fetchApiPrice(feed, apiConfig);
        return { feed, value };
      } catch (error) {
        this.logger.warn(`API price unavailable for ${feed.name}; using CCXT: ${asError(error).message}`);
      }
    }

    return this.ccxtFeed.getValue(feed);
  }

  async getValues(feeds: FeedId[]): Promise<FeedValueData[]> {
    const coinGeckoFeeds = feeds
      .map((feed) => this.toCoinGeckoFeed(feed))
      .filter((item): item is CoinGeckoFeed => item !== undefined);

    let coinGeckoPrices: Map<string, number> | undefined;
    if (coinGeckoFeeds.length > 0) {
      try {
        coinGeckoPrices = await this.fetchCoinGeckoPrices(coinGeckoFeeds);
      } catch (error) {
        this.logger.warn(
          `Bulk CoinGecko request failed for ${coinGeckoFeeds.length} feeds; using CCXT: ${asError(error).message}`,
        );
      }
    }

    const coinGeckoByKey = new Map(coinGeckoFeeds.map((item) => [this.feedKey(item.feed), item]));

    return Promise.all(
      feeds.map(async (feed) => {
        const coinGeckoFeed = coinGeckoByKey.get(this.feedKey(feed));
        if (coinGeckoFeed !== undefined) {
          const price = coinGeckoPrices?.get(coinGeckoFeed.id);
          if (price !== undefined) {
            this.logger.log(`Using bulk API price for ${feed.name}: ${price}`);
            return { feed, value: price };
          }

          this.logger.warn(`Bulk API price unavailable for ${feed.name}; using CCXT`);
          return this.ccxtFeed.getValue(feed);
        }

        return this.getValue(feed);
      }),
    );
  }

  async getVolumes(feeds: FeedId[], volumeWindow: number): Promise<FeedVolumeData[]> {
    // The custom API supplies prices only. Trade volumes continue to come from CCXT.
    return this.ccxtFeed.getVolumes(feeds, volumeWindow);
  }

  private async fetchApiPrice(feed: FeedId, config: ApiConfig): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_API_TIMEOUT_MS);

    try {
      const response = await fetch(config.url, {
        method: 'GET',
        headers: this.resolveHeaders(config.headers),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const body: unknown = await response.json();
      const rawPrice = this.readPath(body, config.pricePath);
      const price = typeof rawPrice === 'number' ? rawPrice : Number(rawPrice);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`Invalid price at JSON path "${config.pricePath}"`);
      }

      this.logger.debug(`Using API price for ${feed.name}: ${price}`);
      return price;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toCoinGeckoFeed(feed: FeedId): CoinGeckoFeed | undefined {
    const config = this.configByKey.get(this.feedKey(feed))?.api;
    if (!this.isApiEnabled(config)) return undefined;

    try {
      const url = new URL(config.url);
      if (!COINGECKO_HOSTS.has(url.hostname) || url.pathname !== '/api/v3/simple/price') return undefined;

      const ids = url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [];
      if (ids.length !== 1) return undefined;

      return { feed, config, id: ids[0] };
    } catch {
      return undefined;
    }
  }

  private async fetchCoinGeckoPrices(feeds: CoinGeckoFeed[]): Promise<Map<string, number>> {
    const ids = [...new Set(feeds.map((item) => item.id))];
    const now = Date.now();

    if (this.coinGeckoCache !== undefined && this.coinGeckoCache.expiresAt > now) {
      const hasAllIds = ids.every((id) => this.coinGeckoCache?.prices.has(id));
      if (hasAllIds) return this.coinGeckoCache.prices;
    }

    const first = feeds[0];
    const sourceUrl = new URL(first.config.url);
    sourceUrl.searchParams.set('ids', ids.join(','));
    sourceUrl.searchParams.set('vs_currencies', 'usd');

    const timeoutMs = Math.max(...feeds.map((item) => item.config.timeoutMs ?? DEFAULT_API_TIMEOUT_MS));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(sourceUrl, {
        method: 'GET',
        headers: this.resolveHeaders(first.config.headers),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const body: unknown = await response.json();
      const prices = new Map<string, number>();
      for (const id of ids) {
        try {
          const rawPrice = this.readPath(body, `${id}.usd`);
          const price = typeof rawPrice === 'number' ? rawPrice : Number(rawPrice);
          if (Number.isFinite(price) && price > 0) prices.set(id, price);
        } catch {
          // A missing asset falls back to CCXT without invalidating the full bulk response.
        }
      }

      if (prices.size === 0) throw new Error('Bulk response contained no valid USD prices');

      this.coinGeckoCache = { expiresAt: now + API_CACHE_TTL_MS, prices };
      this.logger.log(`Bulk CoinGecko request returned ${prices.size}/${ids.length} prices`);
      return prices;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isApiEnabled(config: ApiConfig | undefined): config is ApiConfig {
    return config?.enabled === 1 && config.url.trim() !== '' && config.pricePath.trim() !== '';
  }

  private resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    if (headers === undefined) return { accept: 'application/json' };

    return Object.fromEntries(
      Object.entries({ accept: 'application/json', ...headers }).map(([name, value]) => [
        name,
        value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, envName: string) => {
          const resolved = process.env[envName];
          if (resolved === undefined) throw new Error(`Required environment variable ${envName} is not set`);
          return resolved;
        }),
      ]),
    );
  }

  private readPath(value: unknown, path: string): unknown {
    return path
      .split('.')
      .filter(Boolean)
      .reduce<unknown>((current, segment) => {
        if (typeof current !== 'object' || current === null || !(segment in current)) {
          throw new Error(`JSON path "${path}" was not found`);
        }
        return (current as Record<string, unknown>)[segment];
      }, value);
  }

  private feedKey(feed: FeedId): string {
    return `${feed.category}:${feed.name}`;
  }

  private loadConfig(): FeedConfig[] {
    return process.env.NETWORK === 'local-test' ? testFeeds : prodFeeds;
  }
}
