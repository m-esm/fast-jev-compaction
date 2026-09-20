import { JevHttpError } from './request.js';
import type { JevAsker } from './types.js';

/** Transport failures only; validation and local processing failures are not transient. */
export class JevNetworkError extends Error {
  constructor(cause: unknown) {
    super('Jev network request failed', { cause });
    this.name = 'JevNetworkError';
  }
}

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  sleep: (ms: number) => Promise<void>;
}

export function withRetry(asker: JevAsker, { retries = 1, delayMs = 500, sleep }: RetryOptions) {
  const stats = { requests: 0, retries: 0 };
  return {
    stats,
    async ask(...args: Parameters<JevAsker['ask']>) {
      for (let attempt = 0; ; attempt += 1) {
        stats.requests += 1;
        try {
          return await asker.ask(...args);
        } catch (error) {
          const transient = error instanceof JevNetworkError ||
            (error instanceof TypeError && /fetch|network/i.test(error.message)) ||
            (error instanceof JevHttpError && (error.status === 429 || error.status >= 500 && error.status < 600));
          if (!transient || attempt >= retries) throw error;
          await sleep(delayMs);
          stats.retries += 1;
        }
      }
    },
  };
}
