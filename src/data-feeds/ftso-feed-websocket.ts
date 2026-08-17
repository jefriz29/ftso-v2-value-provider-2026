import { Logger } from '@nestjs/common';
import { FeedId, FeedValueData, FeedVolumeData } from '../dto/provider-requests.dto';
import { BaseDataFeed } from './base-feed';
import { FtsoFeedV1 } from './ftso-feed-v1';
import { WebSocketPriceService } from './websocket-price-service';

/** Direct exchange WebSockets first; existing API/CCXT implementation as fallback. */
export class FtsoFeedWebSocket implements BaseDataFeed {
  private readonly logger = new Logger(FtsoFeedWebSocket.name);
  private readonly websocket = new WebSocketPriceService();
  private readonly fallback = new FtsoFeedV1();

  async start(): Promise<void> {
    this.websocket.start();
    await this.fallback.start();
    this.logger.log('WebSocket-primary provider initialized; API/CCXT fallback enabled');
  }

  async getValue(feed: FeedId): Promise<FeedValueData> {
    const direct = this.websocket.getMedian(feed);
    if (direct !== undefined) {
      this.logDirectPrice(feed, direct.value, direct.sources, direct.newestAgeMs);
      return { feed, value: direct.value };
    }

    this.logger.warn(`No fresh direct WebSocket price for ${feed.name}; using API/CCXT fallback`);
    return this.fallback.getValue(feed);
  }

  async getValues(feeds: FeedId[]): Promise<FeedValueData[]> {
    const results = new Map<string, FeedValueData>();
    const missing: FeedId[] = [];

    for (const feed of feeds) {
      const direct = this.websocket.getMedian(feed);
      if (direct === undefined) {
        missing.push(feed);
        continue;
      }
      this.logDirectPrice(feed, direct.value, direct.sources, direct.newestAgeMs);
      results.set(this.feedKey(feed), { feed, value: direct.value });
    }

    if (missing.length > 0) {
      this.logger.warn(`${missing.length}/${feeds.length} feeds lack a fresh WebSocket price; using API/CCXT fallback`);
      const fallbackValues = await this.fallback.getValues(missing);
      for (const value of fallbackValues) results.set(this.feedKey(value.feed), value);
    }

    return feeds.map((feed) => results.get(this.feedKey(feed)) ?? { feed, value: undefined });
  }

  async getVolumes(feeds: FeedId[], volumeWindow: number): Promise<FeedVolumeData[]> {
    return this.fallback.getVolumes(feeds, volumeWindow);
  }

  private logDirectPrice(feed: FeedId, value: number, sources: string[], ageMs: number): void {
    this.logger.log(
      `Using direct WebSocket median for ${feed.name}: ${value} sources=${sources.join(',')} newestAgeMs=${ageMs}`,
    );
  }

  private feedKey(feed: FeedId): string {
    return `${feed.category}:${feed.name}`;
  }
}
