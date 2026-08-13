import { Logger } from '@nestjs/common';
import { FeedId, FeedValueData, FeedVolumeData } from '../dto/provider-requests.dto';
import { asError } from '../utils/error';
import { BaseDataFeed } from './base-feed';
import { CcxtFeed } from './ccxt-provider-service';

import prodFeeds from '../config/feeds.json';
import testFeeds from '../config/test-feeds.json';

interface ApiConfig {
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

  async start(): Promise<void> {
    const config = this.loadConfig();
    for (const item of config) {
      this.configByKey.set(this.feedKey(item.feed), item);
    }

    await this.ccxtFeed.start();

    const apiFeedCount = config.filter((item) => item.api !== undefined).length;
    this.logger.log(`Initialized ${config.length} feeds (${apiFeedCount} API-primary, CCXT fallback enabled)`);
  }

  async getValue(feed: FeedId): Promise<FeedValueData> {
    const apiConfig = this.configByKey.get(this.feedKey(feed))?.api;

    if (apiConfig !== undefined) {
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
    return Promise.all(feeds.map((feed) => this.getValue(feed)));
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
    return path.split('.').filter(Boolean).reduce<unknown>((current, segment) => {
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
