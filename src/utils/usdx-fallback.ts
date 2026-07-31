import { Logger } from '@nestjs/common';
import { sleepFor } from './retry';
import { asError } from './error';

/**
 * TEMPORARY stopgap price source for USDX/USD.
 *
 * BitMart no longer lists USDX/USDT — the only CEX source configured in feeds.json —
 * and no other exchange lists USDX, so the feed otherwise has no price at all. Until
 * a CEX source is available again, fall back to the on-chain price from
 * GeckoTerminal (CoinGecko's DEX API, no key required), polled every 5 minutes.
 *
 * This is deliberately self-contained: delete this file and its two call sites in
 * `CcxtFeed` to remove the fallback. It is also fail-silent by design — every failure
 * mode degrades to "no fallback price", which is exactly the current behaviour,
 * and can never throw into or otherwise disturb the rest of the provider.
 */

export const USDX_FEED_NAME = 'USDX/USD';

/** Hex Trust USD (USDX) on Flare. */
const TOKEN_ADDRESS = '0x4A771CC1A39FDD8AA08B8EA51F7FD412E73B3D2B';

const PRICE_URL =
  process.env.USDX_FALLBACK_URL ??
  `https://api.geckoterminal.com/api/v2/simple/networks/flare/token_price/${TOKEN_ADDRESS}`;

const POLL_INTERVAL_MS = process.env.USDX_FALLBACK_POLL_MS ? parseInt(process.env.USDX_FALLBACK_POLL_MS) : 300_000;

/** Don't serve a price older than this. */
const MAX_AGE_MS = process.env.USDX_FALLBACK_MAX_AGE_MS ? parseInt(process.env.USDX_FALLBACK_MAX_AGE_MS) : 3_600_000;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Sanity band. Liquidity behind this price is tiny, so refuse anything that isn't roughly at peg rather than trusting the pools.
 */
const MIN_VALUE = 0.9;
const MAX_VALUE = 1.1;

export class UsdxFallback {
  private readonly logger = new Logger(UsdxFallback.name);
  private price: { value: number; time: number } | undefined;

  /** Starts background polling. Returns immediately; never throws. */
  start() {
    try {
      if (process.env.USDX_FALLBACK_DISABLED === 'true') {
        this.logger.log(`${USDX_FEED_NAME} fallback disabled via USDX_FALLBACK_DISABLED`);
        return;
      }
      this.logger.log(`Starting ${USDX_FEED_NAME} DEX fallback, polling every ${POLL_INTERVAL_MS}ms`);
      void this.poll();
    } catch (e) {
      this.logger.warn(`Failed to start ${USDX_FEED_NAME} fallback, continuing without it: ${asError(e).message}`);
    }
  }

  /** Last known price, or undefined if never fetched or stale. Never throws. */
  getPrice(): number | undefined {
    if (this.price === undefined) return undefined;

    const age = Date.now() - this.price.time;
    if (age > MAX_AGE_MS) {
      this.logger.warn(`${USDX_FEED_NAME} fallback price is stale (${Math.round(age / 1000)}s old), ignoring`);
      return undefined;
    }
    return this.price.value;
  }

  private async poll() {
    for (;;) {
      try {
        const value = await this.fetchPrice();
        if (value !== undefined) {
          this.logger.log(`${USDX_FEED_NAME} DEX fallback price: ${value}`);
          this.price = { value, time: Date.now() };
        }
      } catch (e) {
        this.logger.warn(`Failed to fetch ${USDX_FEED_NAME} fallback price: ${asError(e).message}`);
      }
      await sleepFor(POLL_INTERVAL_MS);
    }
  }

  private async fetchPrice(): Promise<number | undefined> {
    const response = await fetch(PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    const body = (await response.json()) as { data?: { attributes?: { token_prices?: Record<string, string> } } };
    const prices = body?.data?.attributes?.token_prices ?? {};
    const value = parseFloat(prices[TOKEN_ADDRESS.toLowerCase()]);

    if (!isFinite(value) || value <= 0) {
      this.logger.warn(`Ignoring invalid ${USDX_FEED_NAME} fallback price: ${value}`);
      return undefined;
    }
    if (value < MIN_VALUE || value > MAX_VALUE) {
      this.logger.warn(
        `Ignoring out-of-band ${USDX_FEED_NAME} fallback price ${value} (expected [${MIN_VALUE}, ${MAX_VALUE}])`,
      );
      return undefined;
    }
    return value;
  }
}
