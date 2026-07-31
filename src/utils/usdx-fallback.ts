import { Logger } from '@nestjs/common';
import { sleepFor } from './retry';

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

/**
 * Deliberately not `asError`, which itself throws when handed a non-Error value.
 * Called from catch blocks, where throwing would break out of the polling loop.
 */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

export class UsdxFallback {
  private readonly logger = new Logger(UsdxFallback.name);
  private price: { value: number; time: number } | undefined;
  /** Whether the last poll failed, so an outage warns once rather than every cycle. */
  private failing = false;
  /** Whether the stale-price warning has already been emitted for the current price. */
  private staleWarned = false;

  /** Starts background polling. Returns immediately; never throws. */
  start() {
    try {
      if (process.env.USDX_FALLBACK_DISABLED === 'true') {
        this.logger.log(`${USDX_FEED_NAME} fallback disabled via USDX_FALLBACK_DISABLED`);
        return;
      }
      this.logger.log(`Starting ${USDX_FEED_NAME} DEX fallback, polling every ${POLL_INTERVAL_MS}ms`);
      this.runPollLoop();
    } catch (e) {
      this.logger.warn(`Failed to start ${USDX_FEED_NAME} fallback, continuing without it: ${messageOf(e)}`);
    }
  }

  /**
   * Last-resort net: `poll` is written so it can never reject, but if it somehow
   * does, restart it rather than silently stopping forever.
   */
  private runPollLoop() {
    void this.poll().catch((e: unknown) => {
      this.logger.error(`${USDX_FEED_NAME} poll loop exited unexpectedly, restarting: ${messageOf(e)}`);
      setTimeout(() => this.runPollLoop(), POLL_INTERVAL_MS).unref();
    });
  }

  /** Last known price, or undefined if never fetched or stale. Never throws. */
  getPrice(): number | undefined {
    if (this.price === undefined) return undefined;

    const age = Date.now() - this.price.time;
    if (age > MAX_AGE_MS) {
      // Warn once when it goes stale, not on every query.
      if (!this.staleWarned) {
        this.logger.warn(`${USDX_FEED_NAME} fallback price is stale (${Math.round(age / 1000)}s old), ignoring`);
        this.staleWarned = true;
      }
      return undefined;
    }
    return this.price.value;
  }

  private async poll() {
    for (;;) {
      try {
        const value = await this.fetchPrice();
        if (value !== undefined) {
          // Only announce state changes; a healthy poll every few minutes is not
          // worth a log line, so it goes to debug (off unless LOG_LEVEL=debug).
          if (this.price === undefined) {
            this.logger.log(`${USDX_FEED_NAME} DEX fallback price: ${value}`);
          } else if (this.failing) {
            this.logger.log(`${USDX_FEED_NAME} DEX fallback recovered, price: ${value}`);
          } else {
            this.logger.debug(`${USDX_FEED_NAME} DEX fallback price: ${value}`);
          }
          this.failing = false;
          this.staleWarned = false;
          this.price = { value, time: Date.now() };
        }
      } catch (e) {
        // Keep polling: a failed fetch just means the previous price stands until
        // it ages out, and the next cycle may well succeed. Warn once per outage,
        // then stay quiet until something changes.
        if (this.failing) {
          this.logger.debug(`${USDX_FEED_NAME} fallback still failing: ${messageOf(e)}`);
        } else {
          this.logger.warn(`${USDX_FEED_NAME} fallback poll failed, will keep retrying: ${messageOf(e)}`);
        }
        this.failing = true;
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

    // Thrown rather than logged here so a persistently misbehaving upstream goes
    // through the same warn-once-per-outage handling as a failed request.
    if (!isFinite(value) || value <= 0) {
      throw new Error(`invalid price: ${value}`);
    }
    if (value < MIN_VALUE || value > MAX_VALUE) {
      throw new Error(`price ${value} outside sanity band [${MIN_VALUE}, ${MAX_VALUE}]`);
    }
    return value;
  }
}
