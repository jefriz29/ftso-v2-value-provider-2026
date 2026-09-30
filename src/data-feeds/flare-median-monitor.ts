import { Logger } from '@nestjs/common';
import { FeedId } from '../dto/provider-requests.dto';

export interface PriceObservation {
  feed: FeedId;
  v1?: number;
  websocket?: number;
  ccxt?: number;
  selected?: number;
  selectedSource: string;
  localMedian?: number;
}

interface FlareFeedBody {
  votingRoundId: number;
  id: string;
  value: number;
  turnoutBIPS: number;
  decimals: number;
}

interface FlareFeedResponse {
  body: FlareFeedBody;
}

const DEFAULT_URL = 'https://flr-data-availability.flare.network/api/v0/ftso/anchor-feeds-with-proof';

export class FlareMedianMonitor {
  private readonly logger = new Logger(FlareMedianMonitor.name);
  private readonly enabled = process.env.FLARE_MEDIAN_MONITOR_ENABLED === 'true';
  private readonly url = process.env.FLARE_MEDIAN_MONITOR_URL ?? DEFAULT_URL;
  private readonly delayMs = positiveInteger(process.env.FLARE_MEDIAN_MONITOR_DELAY_MS, 180_000);
  private readonly retryMs = positiveInteger(process.env.FLARE_MEDIAN_MONITOR_RETRY_MS, 30_000);
  private readonly maxAttempts = positiveInteger(process.env.FLARE_MEDIAN_MONITOR_MAX_ATTEMPTS, 5);
  private readonly pendingRounds = new Set<number>();

  schedule(votingRoundId: number, observations: PriceObservation[]): void {
    if (!this.enabled || this.pendingRounds.has(votingRoundId) || observations.length === 0) return;

    this.pendingRounds.add(votingRoundId);
    const timer = setTimeout(() => {
      void this.compareRound(votingRoundId, observations, 1);
    }, this.delayMs);
    timer.unref();

    this.logger.log(
      `Scheduled Flare median comparison round=${votingRoundId} feeds=${observations.length} delayMs=${this.delayMs}`,
    );
  }

  private async compareRound(votingRoundId: number, observations: PriceObservation[], attempt: number): Promise<void> {
    try {
      const response = await fetch(`${this.url}?voting_round_id=${votingRoundId}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ feed_ids: observations.map((item) => encodeFeedId(item.feed)) }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const flareFeeds = (await response.json()) as FlareFeedResponse[];
      const flareById = new Map(flareFeeds.map((item) => [item.body.id.toLowerCase(), item.body]));
      const totals = { selected: 0, v1: 0, websocket: 0, ccxt: 0, localMedian: 0 };
      const counts = { selected: 0, v1: 0, websocket: 0, ccxt: 0, localMedian: 0 };
      const closestCounts = { selected: 0, v1: 0, websocket: 0, ccxt: 0, localMedian: 0 };

      for (const observation of observations) {
        const flare = flareById.get(encodeFeedId(observation.feed).toLowerCase());
        if (flare === undefined) {
          this.logger.warn(`Flare median unavailable round=${votingRoundId} feed=${observation.feed.name}`);
          continue;
        }

        const flareMedian = flare.value * 10 ** -flare.decimals;
        const deviations = {
          selected: percentageDeviation(observation.selected, flareMedian),
          v1: percentageDeviation(observation.v1, flareMedian),
          websocket: percentageDeviation(observation.websocket, flareMedian),
          ccxt: percentageDeviation(observation.ccxt, flareMedian),
          localMedian: percentageDeviation(observation.localMedian, flareMedian),
        };
        const available = Object.entries(deviations).filter((entry): entry is [keyof typeof deviations, number] =>
          Number.isFinite(entry[1]),
        );
        const closestDeviation = available.length === 0 ? undefined : Math.min(...available.map(([, value]) => value));
        const closest = available.filter(([, value]) => value === closestDeviation).map(([name]) => name);

        for (const [name, value] of available) {
          totals[name] += value;
          counts[name] += 1;
          if (value === closestDeviation) closestCounts[name] += 1;
        }

        this.logger.log(
          `Flare deviation round=${votingRoundId} feed=${observation.feed.name} ` +
            `flareMedian=${flareMedian} turnoutPct=${(flare.turnoutBIPS / 100).toFixed(2)} ` +
            `selected=${formatPrice(observation.selected)} selectedSource=${observation.selectedSource} ` +
            `selectedDeviationPct=${formatDeviation(deviations.selected)} ` +
            `v1=${formatPrice(observation.v1)} v1DeviationPct=${formatDeviation(deviations.v1)} ` +
            `websocket=${formatPrice(observation.websocket)} websocketDeviationPct=${formatDeviation(deviations.websocket)} ` +
            `ccxt=${formatPrice(observation.ccxt)} ccxtDeviationPct=${formatDeviation(deviations.ccxt)} ` +
            `localMedian=${formatPrice(observation.localMedian)} ` +
            `localMedianDeviationPct=${formatDeviation(deviations.localMedian)} closest=${closest.join(',') || 'n/a'}`,
        );
      }

      this.logger.log(
        `Flare deviation summary round=${votingRoundId} ` +
          `selectedAvgPct=${average(totals.selected, counts.selected)} ` +
          `v1AvgPct=${average(totals.v1, counts.v1)} ` +
          `websocketAvgPct=${average(totals.websocket, counts.websocket)} ` +
          `ccxtAvgPct=${average(totals.ccxt, counts.ccxt)} ` +
          `localMedianAvgPct=${average(totals.localMedian, counts.localMedian)} ` +
          `closestCounts=${JSON.stringify(closestCounts)}`,
      );
      this.pendingRounds.delete(votingRoundId);
    } catch (error) {
      if (attempt < this.maxAttempts) {
        this.logger.warn(
          `Flare median not ready round=${votingRoundId} attempt=${attempt}/${this.maxAttempts}; retrying in ${this.retryMs}ms: ${errorMessage(error)}`,
        );
        const timer = setTimeout(() => {
          void this.compareRound(votingRoundId, observations, attempt + 1);
        }, this.retryMs);
        timer.unref();
        return;
      }

      this.pendingRounds.delete(votingRoundId);
      this.logger.error(
        `Flare median comparison failed round=${votingRoundId} attempts=${this.maxAttempts}: ${errorMessage(error)}`,
      );
    }
  }
}

export function encodeFeedId(feed: FeedId): string {
  const bytes = Buffer.alloc(21);
  bytes[0] = feed.category;
  const name = Buffer.from(feed.name, 'ascii');
  if (name.length > 20) throw new Error(`Feed name is too long: ${feed.name}`);
  name.copy(bytes, 1);
  return `0x${bytes.toString('hex')}`;
}

export function calculateMedianPrice(values: Array<number | undefined>): number | undefined {
  const prices = values.filter(validPrice).sort((a, b) => a - b);
  if (prices.length === 0) return undefined;
  const middle = Math.floor(prices.length / 2);
  return prices.length % 2 === 1 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2;
}

export function percentageDeviation(value: number | undefined, reference: number): number {
  return validPrice(value) && validPrice(reference) ? (Math.abs(value - reference) / reference) * 100 : Number.NaN;
}

function validPrice(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatPrice(value: number | undefined): string {
  return validPrice(value) ? `${value}` : 'unavailable';
}

function formatDeviation(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : 'n/a';
}

function average(total: number, count: number): string {
  return count === 0 ? 'n/a' : (total / count).toFixed(6);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
