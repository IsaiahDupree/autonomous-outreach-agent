/**
 * src/services/retry-queue.ts — in-process retry queue with exponential backoff.
 *
 * Replaces the ad-hoc one-shot retry-queued.ts script. Each item has an id,
 * payload, attempt count, and next-eligible timestamp. drain() processes due
 * items, requeues failures with backoff, and gives up after maxAttempts.
 *
 * Single-process, in-memory. Persistence is the caller's responsibility
 * (e.g. mark Supabase rows as `error` once exhausted).
 */
import logger from "../config/logger";

export interface RetryItem<T> {
  id: string;
  payload: T;
  attempts: number;
  nextAt: number;
  lastError?: string;
}

export interface RetryQueueOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface DrainResult<T> {
  succeeded: string[];
  failed: RetryItem<T>[];
  exhausted: RetryItem<T>[];
}

const DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 5 * 60 * 1000,
  jitter: true,
};

export class RetryQueue<T> {
  private items = new Map<string, RetryItem<T>>();
  private exhaustedItems: RetryItem<T>[] = [];
  private readonly opts: Required<Omit<RetryQueueOptions, "now" | "sleep" | "random">> & {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
  };

  constructor(
    private readonly process: (payload: T, item: RetryItem<T>) => Promise<boolean>,
    options: RetryQueueOptions = {}
  ) {
    this.opts = {
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      factor: options.factor ?? DEFAULTS.factor,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      jitter: options.jitter ?? DEFAULTS.jitter,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
    };
  }

  enqueue(id: string, payload: T): void {
    if (this.items.has(id)) return;
    this.items.set(id, {
      id,
      payload,
      attempts: 0,
      nextAt: this.opts.now(),
    });
  }

  size(): number {
    return this.items.size;
  }

  pending(): RetryItem<T>[] {
    return Array.from(this.items.values());
  }

  exhausted(): RetryItem<T>[] {
    return this.exhaustedItems.slice();
  }

  /** Compute backoff delay for the Nth attempt (1-indexed). */
  backoffFor(attempts: number): number {
    const raw = this.opts.baseDelayMs * Math.pow(this.opts.factor, Math.max(0, attempts - 1));
    const capped = Math.min(raw, this.opts.maxDelayMs);
    if (!this.opts.jitter) return capped;
    // Full jitter: random in [capped/2, capped]
    return Math.floor(capped / 2 + this.opts.random() * (capped / 2));
  }

  /**
   * Process all currently-due items once. Items that fail are requeued with
   * backoff; items that exceed maxAttempts move to the exhausted list.
   * Does not wait for not-yet-due items — call drain() for that.
   */
  async tick(): Promise<DrainResult<T>> {
    const now = this.opts.now();
    const due = Array.from(this.items.values()).filter((i) => i.nextAt <= now);
    const result: DrainResult<T> = { succeeded: [], failed: [], exhausted: [] };

    for (const item of due) {
      item.attempts++;
      let ok = false;
      try {
        ok = await this.process(item.payload, item);
      } catch (e) {
        item.lastError = (e as Error).message;
        logger.warn(`[RetryQueue] ${item.id} attempt ${item.attempts} threw: ${item.lastError}`);
      }

      if (ok) {
        this.items.delete(item.id);
        result.succeeded.push(item.id);
        continue;
      }

      if (item.attempts >= this.opts.maxAttempts) {
        this.items.delete(item.id);
        this.exhaustedItems.push(item);
        result.exhausted.push(item);
        logger.error(`[RetryQueue] ${item.id} exhausted after ${item.attempts} attempts`);
        continue;
      }

      const delay = this.backoffFor(item.attempts);
      item.nextAt = this.opts.now() + delay;
      result.failed.push(item);
      logger.info(`[RetryQueue] ${item.id} retry ${item.attempts}/${this.opts.maxAttempts} in ${delay}ms`);
    }

    return result;
  }

  /**
   * Drain the queue: keep ticking (sleeping until the next-due item) until
   * the queue is empty or every remaining item is exhausted.
   */
  async drain(): Promise<DrainResult<T>> {
    const aggregate: DrainResult<T> = { succeeded: [], failed: [], exhausted: [] };

    while (this.items.size > 0) {
      const now = this.opts.now();
      const next = Math.min(...Array.from(this.items.values()).map((i) => i.nextAt));
      const wait = next - now;
      if (wait > 0) await this.opts.sleep(wait);

      const round = await this.tick();
      aggregate.succeeded.push(...round.succeeded);
      aggregate.exhausted.push(...round.exhausted);
      // failed items stay in queue; only surface them on the final aggregate
    }

    aggregate.failed = []; // none left pending after drain
    return aggregate;
  }
}
