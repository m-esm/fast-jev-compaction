import { expect, it, vi } from 'vitest';
import { JevHttpError, parseJevResponse } from '../src/request.js';
import { JevNetworkError, withRetry } from '../src/retry.js';
import { JevClient } from '../src/client.js';

it.each([new JevHttpError(429, 'busy'), new JevHttpError(503, 'busy'), new JevNetworkError(new Error('offline')), new TypeError('fetch failed')])('retries transient failures once: %s', async (error) => {
  const ask = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ answers: {} });
  const sleep = vi.fn().mockResolvedValue(undefined);
  const retry = withRetry({ ask }, { sleep });
  expect(await retry.ask('', {})).toEqual({ answers: {} });
  expect(sleep).toHaveBeenCalledWith(500);
  expect(retry.stats).toEqual({ requests: 2, retries: 1 });
});

it.each([new JevHttpError(400, 'bad'), new Error('Jev returned malformed JSON'), new Error('local failure')])('does not retry permanent errors: %s', async (error) => {
  const ask = vi.fn().mockRejectedValue(error);
  await expect(withRetry({ ask }, { sleep: async () => {} }).ask('', {})).rejects.toBe(error);
  expect(ask).toHaveBeenCalledTimes(1);
});

it('stops after its retry budget and preserves HTTP error text', async () => {
  const ask = vi.fn(() => Promise.resolve(parseJevResponse(500, false, 'boom')));
  await expect(withRetry({ ask }, { sleep: async () => {} }).ask('', {})).rejects.toMatchObject({ status: 500, message: 'Jev request failed (500): boom' });
  expect(ask).toHaveBeenCalledTimes(2);
});

it('retries network errors through the Node client', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('{"answers":{}}'));
  expect(await new JevClient({ apiKey: 'fake', fetch: fetcher }).ask('', {})).toEqual({ answers: {} });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
