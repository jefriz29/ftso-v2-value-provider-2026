import { WebSocketPriceService, WebSocketMedian } from './websocket-price-service';

interface SocketTestAccess {
  loadMappings(): void;
  handleMessage(exchange: string, raw: string): void;
  getMedian(feed: { category: number; name: string }): WebSocketMedian | undefined;
  samples: Map<string, { price: number; receivedAt: number }>;
}

describe('HYPE and LEO direct sockets', () => {
  function service(): SocketTestAccess {
    const result = new WebSocketPriceService() as unknown as SocketTestAccess;
    result.loadMappings();
    return result;
  }
  it('maps HYPE to spot Bybit and converts fresh USDT to USD', () => {
    const s = service();
    s.handleMessage(
      'kraken',
      JSON.stringify({ channel: 'ticker', data: [{ symbol: 'USDT/USD', bid: 0.998, ask: 1 }] }),
    );
    s.handleMessage('bybit', JSON.stringify({ topic: 'tickers.HYPEUSDT', data: { lastPrice: '40' } }));
    expect(s.getMedian({ category: 1, name: 'HYPE/USD' }).value).toBeCloseTo(39.96);
  });
  it('does not return HYPE without a fresh USDT/USD conversion', () => {
    const s = service();
    s.handleMessage('bybit', JSON.stringify({ topic: 'tickers.HYPEUSDT', data: { lastPrice: '40' } }));
    expect(s.getMedian({ category: 1, name: 'HYPE/USD' })).toBeUndefined();
  });
  it('routes Bitfinex channel IDs and ignores heartbeat price refreshes', () => {
    const s = service();
    s.handleMessage(
      'bitfinex',
      JSON.stringify({ event: 'subscribed', channel: 'ticker', chanId: 17, symbol: 'tLEOUSD' }),
    );
    s.handleMessage('bitfinex', JSON.stringify([17, [9, 1, 9.2, 1, 0, 0, 9.1]]));
    expect(s.getMedian({ category: 1, name: 'LEO/USD' }).value).toBeCloseTo(9.1);
    const sample = s.samples.get('bitfinex:tLEOUSD');
    sample.receivedAt = Date.now() - 60_000;
    s.handleMessage('bitfinex', JSON.stringify([17, 'hb']));
    expect(s.getMedian({ category: 1, name: 'LEO/USD' })).toBeUndefined();
  });
});
