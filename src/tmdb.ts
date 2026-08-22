import { config } from './config.js';

export type Movie = {
  tmdbId: number;
  title: string;
  year: number | null;
  releaseDate: string | null;
  /** Only present on a details lookup: Released, Post Production, Planned, ... */
  status: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  trailerKey: string | null;
  overview: string;
  popularity: number;
};

/**
 * A film nobody can watch yet has no business on the board: it would sit there
 * winning interest and, if it won, leave the streamer with nothing to play.
 *
 * The date is the deciding fact — TMDB's status lags, and a film can read
 * "Released" for a festival showing months before anyone else can see it, so an
 * unreached date overrules a status that claims otherwise.
 */
export function isReleased(
  releaseDate: string | null | undefined,
  status?: string | null,
  today = new Date().toISOString().slice(0, 10),
): boolean {
  if (!releaseDate) return false;
  if (releaseDate > today) return false;
  // Anything still in production is out regardless of an optimistic date.
  if (status && status !== 'Released') return false;
  return true;
}

export const enabled = (): boolean => Boolean(config.tmdb.apiKey);

/** TMDB hands out two key formats. v4 read tokens are JWTs; v3 keys are hex. */
function authFor(url: URL): Record<string, string> {
  const key = config.tmdb.apiKey;
  if (key.startsWith('ey')) return { Authorization: `Bearer ${key}` };
  url.searchParams.set('api_key', key);
  return {};
}

type Video = { site?: string; type?: string; key?: string; official?: boolean };

/** Best available YouTube clip: an official trailer, then any trailer, then a teaser. */
function pickTrailer(raw: Record<string, unknown>): string | null {
  const videos = (raw.videos as { results?: Video[] } | undefined)?.results ?? [];
  const yt = videos.filter((v) => v.site === 'YouTube' && v.key);
  const best =
    yt.find((v) => v.type === 'Trailer' && v.official) ??
    yt.find((v) => v.type === 'Trailer') ??
    yt.find((v) => v.type === 'Teaser');
  return best?.key ?? null;
}

function normalize(raw: Record<string, unknown>): Movie {
  const date = String(raw.release_date ?? '');
  return {
    tmdbId: Number(raw.id),
    title: String(raw.title ?? raw.original_title ?? 'Untitled'),
    year: date.length >= 4 ? Number(date.slice(0, 4)) : null,
    releaseDate: date || null,
    status: (raw.status as string | undefined) ?? null,
    posterPath: (raw.poster_path as string | null) ?? null,
    backdropPath: (raw.backdrop_path as string | null) ?? null,
    trailerKey: pickTrailer(raw),
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
    // Unreleased films are dropped rather than shown and then refused.
    .filter((m) => m.posterPath && m.year && isReleased(m.releaseDate))
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 8);

  cache.set(q, { at: Date.now(), results });
  return results;
}

export async function byId(tmdbId: number): Promise<Movie | null> {
  if (!enabled()) return null;
  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}`);
  url.searchParams.set('language', 'en-US');
  // One round trip for the details and the trailer.
  url.searchParams.set('append_to_response', 'videos');
  const headers = authFor(url);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  return normalize((await res.json()) as Record<string, unknown>);
}
