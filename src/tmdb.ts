import { config } from './config.js';

export type Movie = {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  popularity: number;
};

export const enabled = (): boolean => Boolean(config.tmdb.apiKey);

/** TMDB hands out two key formats. v4 read tokens are JWTs; v3 keys are hex. */
function authFor(url: URL): Record<string, string> {
  const key = config.tmdb.apiKey;
  if (key.startsWith('ey')) return { Authorization: `Bearer ${key}` };
  url.searchParams.set('api_key', key);
  return {};
}

function normalize(raw: Record<string, unknown>): Movie {
  const date = String(raw.release_date ?? '');
  return {
    tmdbId: Number(raw.id),
    title: String(raw.title ?? raw.original_title ?? 'Untitled'),
    year: date.length >= 4 ? Number(date.slice(0, 4)) : null,
    posterPath: (raw.poster_path as string | null) ?? null,
    overview: String(raw.overview ?? ''),
    popularity: Number(raw.popularity ?? 0),
  };
}

const cache = new Map<string, { at: number; results: Movie[] }>();
const CACHE_MS = 10 * 60 * 1000;

export async function search(query: string): Promise<Movie[]> {
  if (!enabled()) return [];
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const url = new URL('https://api.themoviedb.org/3/search/movie');
  url.searchParams.set('query', q);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('language', 'en-US');
  const headers = authFor(url);

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
  const body = (await res.json()) as { results?: Record<string, unknown>[] };

  const results = (body.results ?? [])
    .map(normalize)
    // A poster is the whole point here, and no-year entries are usually junk.
    .filter((m) => m.posterPath && m.year)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 8);

  cache.set(q, { at: Date.now(), results });
  return results;
}

export async function byId(tmdbId: number): Promise<Movie | null> {
  if (!enabled()) return null;
  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
  url.searchParams.set('language', 'en-US');
  const headers = authFor(url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  return normalize((await res.json()) as Record<string, unknown>);
}
