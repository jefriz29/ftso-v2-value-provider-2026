import { Logger } from '@nestjs/common';
import { FeedId } from '../dto/provider-requests.dto';

import prodFeeds from '../config/feeds.json';
import testFeeds from '../config/test-feeds.json';

type SupportedExchange = 'binance' | 'coinbase' | 'kraken';

interface FeedConfig {
  feed: FeedId;
  sources: { exchange: string; symbol: string }[];
}

interface SourceMapping {
  exchange: SupportedExchange;
  feedKey: string;
  nativeSymbol: string;
  quote: string;
  sourceKey: string;
}

interface PriceSample {
  price: number;
  receivedAt: number;
}

interface ConnectionState {
  socket?: WebSocket;
  attempts: number;
  lastMessageAt: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface WebSocketMedian {
  value: number;
  sources: string[];
  newestAgeMs: number;
}

const EXCHANGES: SupportedExchange[] = ['binance', 'coinbase', 'kraken'];
const ENDPOINTS: Record<SupportedExchange, string> = {
  binance: 'wss://stream.binance.com:9443/ws',
  coinbase: 'wss://ws-feed.exchange.coinbase.com',
  kraken: 'wss://ws.kraken.com/v2',
};

const MAX_AGE_MS = parsePositiveInteger(process.env.WEBSOCKET_MAX_AGE_MS, 15_000);
const MAX_DEVIATION_PERCENT = parsePositiveNumber(process.env.WEBSOCKET_MAX_DEVIATION_PERCENT, 2);
const MIN_SOURCES = parsePositiveInteger(process.env.WEBSOCKET_MIN_SOURCES, 1);
const RECONNECT_MIN_MS = parsePositiveInteger(process.env.WEBSOCKET_RECONNECT_MIN_MS, 1_000);
const RECONNECT_MAX_MS = parsePositiveInteger(process.env.WEBSOCKET_RECONNECT_MAX_MS, 30_000);

/** Persistent unauthenticated exchange sockets with an in-memory BBO cache. */
export class WebSocketPriceService {
  private readonly logger = new Logger(WebSocketPriceService.name);
  private readonly mappings: SourceMapping[] = [];
  private readonly mappingsByExchange = new Map<SupportedExchange, SourceMapping[]>();
  private readonly mappingsByFeed = new Map<string, SourceMapping[]>();
  private readonly samples = new Map<string, PriceSample>();
  private readonly connections = new Map<SupportedExchange, ConnectionState>();
  private watchdog?: ReturnType<typeof setInterval>;

  start(): void {
    this.loadMappings();

    for (const exchange of EXCHANGES) {
      const mappings = this.mappingsByExchange.get(exchange) ?? [];
      if (mappings.length === 0) continue;
      this.connections.set(exchange, { attempts: 0, lastMessageAt: Date.now() });
      this.connect(exchange);
    }

    this.watchdog = setInterval(() => this.checkConnections(), 30_000);
    this.watchdog.unref?.();
    this.logger.log(
      `Initialized ${this.mappings.length} direct WebSocket sources ` +
        `(maxAge=${MAX_AGE_MS}ms, minSources=${MIN_SOURCES})`,
    );
  }

  getMedian(feed: FeedId): WebSocketMedian | undefined {
    const now = Date.now();
    const mappings = this.mappingsByFeed.get(this.feedKey(feed)) ?? [];
    const values: { value: number; source: string; ageMs: number }[] = [];

    for (const mapping of mappings) {
      const sample = this.samples.get(mapping.sourceKey);
      if (sample === undefined) continue;
      const ageMs = now - sample.receivedAt;
      if (ageMs < 0 || ageMs > MAX_AGE_MS) continue;

      let value = sample.price;
      if (mapping.quote === 'USDT') {
        const usdtUsd = this.getUsdtUsd(now);
        if (usdtUsd === undefined) continue;
        value *= usdtUsd;
      }
      values.push({ value, source: mapping.exchange, ageMs });
    }

    if (values.length < MIN_SOURCES) return undefined;

    let accepted = values;
    if (values.length >= 3) {
      const reference = median(values.map((item) => item.value));
      accepted = values.filter((item) => (Math.abs(item.value - reference) / reference) * 100 <= MAX_DEVIATION_PERCENT);
    }
    if (accepted.length < MIN_SOURCES) return undefined;

    return {
      value: median(accepted.map((item) => item.value)),
      sources: [...new Set(accepted.map((item) => item.source))],
      newestAgeMs: Math.min(...accepted.map((item) => item.ageMs)),
    };
  }

  private loadMappings(): void {
    const config = (process.env.NETWORK === 'local-test' ? testFeeds : prodFeeds) as FeedConfig[];
    for (const item of config) {
      for (const source of item.sources ?? []) {
        if (!isSupportedExchange(source.exchange)) continue;
        const feedKey = this.feedKey(item.feed);
        const existingExchangeSource = (this.mappingsByFeed.get(feedKey) ?? []).some(
          (mapping) => mapping.exchange === source.exchange,
        );
        if (existingExchangeSource) {
          this.logger.warn(
            `Ignoring duplicate ${source.exchange} source ${source.symbol} for ${item.feed.name}; using the first mapping`,
          );
          continue;
        }
        const nativeSymbol = this.toNativeSymbol(source.exchange, source.symbol);
        const mapping: SourceMapping = {
          exchange: source.exchange,
          feedKey,
          nativeSymbol,
          quote: source.symbol.split('/').at(-1)?.toUpperCase() ?? '',
          sourceKey: `${source.exchange}:${nativeSymbol}`,
        };
        this.mappings.push(mapping);
        this.appendMapping(this.mappingsByExchange, source.exchange, mapping);
        this.appendMapping(this.mappingsByFeed, mapping.feedKey, mapping);
      }
    }
  }

  private connect(exchange: SupportedExchange): void {
    const state = this.connections.get(exchange);
    if (state === undefined) return;
    this.logger.log(`Connecting to ${exchange} public WebSocket`);
    const socket = new WebSocket(ENDPOINTS[exchange]);
    state.socket = socket;

    socket.onopen = () => {
      state.attempts = 0;
      state.lastMessageAt = Date.now();
      this.subscribe(exchange, socket);
    };
    socket.onmessage = (event) => {
      state.lastMessageAt = Date.now();
      try {
        this.handleMessage(exchange, String(event.data));
      } catch (error) {
        this.logger.debug(`Ignored malformed ${exchange} message: ${String(error)}`);
      }
    };
    socket.onerror = () => this.logger.warn(`${exchange} public WebSocket error`);
    socket.onclose = (event) => {
      this.logger.warn(`${exchange} WebSocket closed code=${event.code}; scheduling reconnect`);
      if (state.socket === socket) state.socket = undefined;
      this.scheduleReconnect(exchange);
    };
  }

  private subscribe(exchange: SupportedExchange, socket: WebSocket): void {
    const symbols = [...new Set((this.mappingsByExchange.get(exchange) ?? []).map((item) => item.nativeSymbol))];
    if (exchange === 'binance') {
      socket.send(
        JSON.stringify({ method: 'SUBSCRIBE', params: symbols.map((symbol) => `${symbol}@bookTicker`), id: 1 }),
      );
    } else if (exchange === 'coinbase') {
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: symbols, channels: ['ticker', 'heartbeat'] }));
    } else {
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: { channel: 'ticker', symbol: symbols, event_trigger: 'bbo', snapshot: true },
          req_id: 1,
        }),
      );
    }
    this.logger.log(`${exchange} connected; subscribed to ${symbols.length} symbols`);
  }

  private handleMessage(exchange: SupportedExchange, raw: string): void {
    const message = JSON.parse(raw) as Record<string, unknown>;
    if (exchange === 'binance') {
      const symbol = typeof message.s === 'string' ? message.s.toLowerCase() : undefined;
      this.storeMidpoint(exchange, symbol, message.b, message.a);
      return;
    }
    if (exchange === 'coinbase') {
      if (message.type === 'error') {
        this.logger.warn(`Coinbase subscription error: ${formatUnknown(message.message)}`);
        return;
      }
      if (message.type !== 'ticker') return;
      const symbol = typeof message.product_id === 'string' ? message.product_id : undefined;
      this.storeMidpoint(exchange, symbol, message.best_bid, message.best_ask, message.price);
      return;
    }

    if (message.success === false) {
      this.logger.warn(`Kraken subscription error: ${formatUnknown(message.error)}`);
      return;
    }
    if (message.channel !== 'ticker' || !Array.isArray(message.data)) return;
    for (const item of message.data as Record<string, unknown>[]) {
      const symbol = typeof item.symbol === 'string' ? item.symbol : undefined;
      this.storeMidpoint(exchange, symbol, item.bid, item.ask, item.last);
    }
  }

  private storeMidpoint(
    exchange: SupportedExchange,
    nativeSymbol: string | undefined,
    rawBid: unknown,
    rawAsk: unknown,
    rawLast?: unknown,
  ): void {
    if (nativeSymbol === undefined) return;
    const bid = Number(rawBid);
    const ask = Number(rawAsk);
    const last = Number(rawLast);
    const price = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid ? (bid + ask) / 2 : last;
    if (!Number.isFinite(price) || price <= 0) return;
    this.samples.set(`${exchange}:${nativeSymbol}`, { price, receivedAt: Date.now() });
  }

  private getUsdtUsd(now: number): number | undefined {
    const mappings = this.mappingsByFeed.get('1:USDT/USD') ?? [];
    const prices: number[] = [];
    for (const mapping of mappings) {
      if (mapping.quote !== 'USD') continue;
      const sample = this.samples.get(mapping.sourceKey);
      if (sample !== undefined && now - sample.receivedAt <= MAX_AGE_MS) prices.push(sample.price);
    }
    return prices.length === 0 ? undefined : median(prices);
  }

  private scheduleReconnect(exchange: SupportedExchange): void {
    const state = this.connections.get(exchange);
    if (state === undefined || state.reconnectTimer !== undefined) return;
    const exponential = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** state.attempts);
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    state.attempts += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.connect(exchange);
    }, delay);
  }

  private checkConnections(): void {
    const now = Date.now();
    for (const [exchange, state] of this.connections) {
      if (state.socket?.readyState === WebSocket.OPEN && now - state.lastMessageAt > 60_000) {
        this.logger.warn(`${exchange} WebSocket silent for 60s; reconnecting`);
        state.socket.close();
      }
    }
  }

  private toNativeSymbol(exchange: SupportedExchange, symbol: string): string {
    if (exchange === 'binance') return symbol.replace('/', '').toLowerCase();
    if (exchange === 'coinbase') return symbol.replace('/', '-').toUpperCase();
    return symbol.toUpperCase();
  }

  private appendMapping<K>(map: Map<K, SourceMapping[]>, key: K, value: SourceMapping): void {
    const entries = map.get(key) ?? [];
    entries.push(value);
    map.set(key, entries);
  }

  private feedKey(feed: FeedId): string {
    return `${feed.category}:${feed.name}`;
  }
}

function isSupportedExchange(exchange: string): exchange is SupportedExchange {
  return EXCHANGES.includes(exchange as SupportedExchange);
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error('Cannot calculate median of an empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return 'unknown error';
  }
}
