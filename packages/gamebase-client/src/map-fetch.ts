import type { Logger } from "@yingyeothon/logger";
import { nullLogger } from "@yingyeothon/logger";
import type { FetchLike } from "./transport.js";
import { resolveFetch } from "./transport.js";

export interface MapFetcherOptions {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  logger?: Logger;
}

export interface MapFetcher {
  /**
   * Fetches an immutable map asset. Results are cached per URL for the life
   * of the fetcher and concurrent calls share one request; a failed fetch is
   * evicted so the next call retries.
   */
  fetch(mapUrl: string): Promise<unknown>;
}

/**
 * Map assets are public and immutable, so the request carries no credentials
 * and a new map version always arrives as a different URL in a later `hello`.
 * The body is parsed as JSON; a non-JSON body is returned as text.
 */
export function createMapFetcher(options: MapFetcherOptions = {}): MapFetcher {
  const { logger = nullLogger } = options;
  const fetchImpl = resolveFetch(options.fetch);
  const cache = new Map<string, Promise<unknown>>();

  async function load(mapUrl: string): Promise<unknown> {
    const response = await fetchImpl(mapUrl);
    if (!response.ok) {
      throw new Error(`Map fetch failed with status ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  return {
    fetch(mapUrl) {
      const cached = cache.get(mapUrl);
      if (cached !== undefined) {
        return cached;
      }
      logger.debug("fetching map", { mapUrl });
      const pending = load(mapUrl).catch((error: unknown) => {
        cache.delete(mapUrl);
        throw error;
      });
      cache.set(mapUrl, pending);
      return pending;
    },
  };
}

export function fetchMap(
  mapUrl: string,
  options?: MapFetcherOptions,
): Promise<unknown> {
  return createMapFetcher(options).fetch(mapUrl);
}
