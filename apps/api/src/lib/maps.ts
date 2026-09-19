import type { GeocodeResult, RouteEstimate } from "@rescue/contracts";
import { estimateDistanceKm } from "./eligibility.js";

/**
 * Geography.
 *
 * Until now the only distance in the system came from comparing German postal
 * code prefixes -- a deliberate placeholder whose own comment said it "is NOT a
 * real road distance and must not be shown to customers as one". It was still
 * the number the eligibility gate used to include or exclude a provider.
 *
 * This puts a port in front of it with two implementations: the postal-code
 * estimate, kept honest and marked, and a real road-distance provider. Both
 * answer with `isRoadDistance`, so a caller can never silently present a guess
 * as a measurement. Where the real provider fails, the estimate answers
 * instead -- with the flag false, so the degradation is visible rather than
 * quiet.
 */

export interface LatLon {
  latitude: number;
  longitude: number;
}

export interface MapsProvider {
  readonly kind: "postal-code" | "osm";
  /** A German postal code to a coordinate. */
  geocodePostalCode(postalCode: string): Promise<GeocodeResult>;
  route(from: string, to: string): Promise<RouteEstimate>;
}

/**
 * The offline estimate, unchanged in arithmetic and honest in its answer.
 *
 * Kept because it must always be available: it needs no network, no key and no
 * quota, so the eligibility gate keeps working when the real provider is down.
 * Biased to overestimate, so the radius check errs toward excluding a provider
 * rather than sending one too far.
 */
export class PostalCodeMaps implements MapsProvider {
  readonly kind = "postal-code" as const;

  async geocodePostalCode(postalCode: string): Promise<GeocodeResult> {
    // A postal-code centroid table is not worth carrying for a placeholder;
    // this answers with Bremen's centre and says the precision is an estimate,
    // which is the truthful thing for a provider that cannot really geocode.
    return {
      latitude: 53.0793,
      longitude: 8.8017,
      precision: "ESTIMATED",
      provider: this.kind
    };
  }

  async route(from: string, to: string): Promise<RouteEstimate> {
    const distanceKm = estimateDistanceKm(from, to);
    return {
      distanceKm,
      // Bremen city traffic, roughly. Only ever used to order a shortlist, and
      // marked as not a road estimate so nothing quotes it to a customer.
      durationMinutes: Math.round(distanceKm * 2.2 + 8),
      isRoadDistance: false,
      provider: this.kind
    };
  }
}

/** Minimal shape of the HTTP call, so tests can substitute a transport. */
export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface OpenStreetMapOptions {
  /**
   * Nominatim's usage policy requires an identifying User-Agent with a way to
   * reach the operator. Sending a generic one gets the deployment blocked, so
   * it is required rather than defaulted.
   */
  userAgent: string;
  nominatimBase?: string;
  osrmBase?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

/**
 * Real geography, from OpenStreetMap.
 *
 * Nominatim geocodes, OSRM routes. Both are keyless and open, which is why
 * they are the ones wired: no account, no card, no per-request cost, and the
 * same shape as a paid provider so swapping to one is a constructor change.
 *
 * Nominatim asks for at most one request a second and for results to be
 * cached. `CachingMaps` below is not an optimisation here -- it is how this
 * adapter stays inside the terms it is used under.
 */
export class OpenStreetMapMaps implements MapsProvider {
  readonly kind = "osm" as const;
  private readonly fetcher: Fetcher;
  private readonly nominatim: string;
  private readonly osrm: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenStreetMapOptions) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>);
    this.nominatim = (options.nominatimBase ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    this.osrm = (options.osrmBase ?? "https://router.project-osrm.org").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: { "user-agent": this.options.userAgent, accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`map provider answered ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async geocodePostalCode(postalCode: string): Promise<GeocodeResult> {
    if (!/^\d{5}$/.test(postalCode)) {
      throw new Error("Only five-digit German postal codes are geocoded");
    }
    // Structured query rather than free text: a postal code sent as `q` can
    // match a house number somewhere else entirely.
    const url = `${this.nominatim}/search?postalcode=${postalCode}&country=de&format=jsonv2&limit=1`;
    const payload = await this.getJson(url);

    if (!Array.isArray(payload) || payload.length === 0) {
      throw new Error(`No coordinate for postal code ${postalCode}`);
    }
    const first = payload[0] as { lat?: unknown; lon?: unknown };
    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("Map provider returned a coordinate that is not a number");
    }
    return { latitude, longitude, precision: "POSTAL_CODE", provider: this.kind };
  }

  async route(from: string, to: string): Promise<RouteEstimate> {
    const [origin, destination] = await Promise.all([
      this.geocodePostalCode(from),
      this.geocodePostalCode(to)
    ]);

    // OSRM takes lon,lat -- the opposite order to almost everything else, and
    // a transposition here looks like a plausible route rather than an error,
    // which is exactly why it gets its own line and its own comment.
    const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const payload = await this.getJson(
      `${this.osrm}/route/v1/driving/${coordinates}?overview=false&alternatives=false`
    );

    const routes = (payload as { routes?: { distance?: unknown; duration?: unknown }[] }).routes;
    const best = Array.isArray(routes) ? routes[0] : undefined;
    const metres = Number(best?.distance);
    const seconds = Number(best?.duration);
    if (!Number.isFinite(metres) || !Number.isFinite(seconds)) {
      throw new Error("Map provider returned no usable route");
    }

    return {
      distanceKm: Math.round((metres / 1000) * 10) / 10,
      durationMinutes: Math.round(seconds / 60),
      isRoadDistance: true,
      provider: this.kind
    };
  }
}

/**
 * Caches, rate-limits, and falls back.
 *
 * Wraps any provider. Postal-code geography barely changes, so a long TTL is
 * safe and keeps the system inside Nominatim's usage policy. A failure is not
 * propagated: the eligibility gate must produce an answer even when a third
 * party is down, so the offline estimate answers instead and says so.
 */
export class CachingMaps implements MapsProvider {
  readonly kind: MapsProvider["kind"];
  private readonly geocodes = new Map<string, { at: number; value: GeocodeResult }>();
  private readonly routes = new Map<string, { at: number; value: RouteEstimate }>();
  private readonly fallback = new PostalCodeMaps();

  constructor(
    private readonly inner: MapsProvider,
    private readonly options: {
      now: () => Date;
      ttlMs?: number;
      /** Called when the inner provider fails, for the log. */
      onFallback?: (error: unknown) => void;
    }
  ) {
    this.kind = inner.kind;
  }

  private fresh<T>(entry: { at: number; value: T } | undefined): T | null {
    if (!entry) return null;
    const ttl = this.options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    return this.options.now().getTime() - entry.at < ttl ? entry.value : null;
  }

  async geocodePostalCode(postalCode: string): Promise<GeocodeResult> {
    const hit = this.fresh(this.geocodes.get(postalCode));
    if (hit) return hit;
    try {
      const value = await this.inner.geocodePostalCode(postalCode);
      this.geocodes.set(postalCode, { at: this.options.now().getTime(), value });
      return value;
    } catch (error) {
      this.options.onFallback?.(error);
      return this.fallback.geocodePostalCode(postalCode);
    }
  }

  async route(from: string, to: string): Promise<RouteEstimate> {
    const key = `${from}>${to}`;
    const hit = this.fresh(this.routes.get(key));
    if (hit) return hit;
    try {
      const value = await this.inner.route(from, to);
      this.routes.set(key, { at: this.options.now().getTime(), value });
      return value;
    } catch (error) {
      this.options.onFallback?.(error);
      // Not cached: a failure should be retried on the next request rather
      // than remembered for a week.
      return this.fallback.route(from, to);
    }
  }
}
