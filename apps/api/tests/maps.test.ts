import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/lib/clock.js";
import {
  CachingMaps,
  OpenStreetMapMaps,
  PostalCodeMaps,
  type Fetcher
} from "../src/lib/maps.js";

/**
 * Geography.
 *
 * The real provider is tested against a substituted transport rather than the
 * live service: a test that reaches a third party is a test that fails when
 * somebody else has an outage, and open services in particular must not be
 * hit by a CI run on every push. What is pinned here is the request this
 * adapter makes, the parsing of the answer, and what happens when the answer
 * is missing, malformed or late.
 *
 * A live check against the real service exists too, at the bottom, and runs
 * only when MAPS_LIVE=1 is set by a person who meant it.
 */

const NOW = new FixedClock(new Date("2026-09-19T08:00:00.000Z"));

function fetcherReturning(byUrl: Record<string, unknown>): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const match = Object.entries(byUrl).find(([fragment]) => url.includes(fragment));
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => match[1] };
  };
  return { fetcher, calls };
}

const BREMEN_MITTE = [{ lat: "53.0758", lon: "8.8072" }];
const BREMEN_NORD = [{ lat: "53.1675", lon: "8.6222" }];

describe("the offline estimate is honest about what it is", () => {
  it("never claims to be a road distance", async () => {
    const estimate = await new PostalCodeMaps().route("28195", "28309");
    expect(estimate.isRoadDistance).toBe(false);
    expect(estimate.provider).toBe("postal-code");
  });

  it("still answers, which is the reason it is kept", async () => {
    const estimate = await new PostalCodeMaps().route("28195", "80331");
    expect(estimate.distanceKm).toBeGreaterThan(0);
    expect(estimate.durationMinutes).toBeGreaterThan(0);
  });
});

describe("the OpenStreetMap adapter", () => {
  it("asks Nominatim for a structured postal code, not free text", async () => {
    const { fetcher, calls } = fetcherReturning({ "/search": BREMEN_MITTE });
    const maps = new OpenStreetMapMaps({ userAgent: "rescue-test/1.0 (test@example.com)", fetcher });

    const result = await maps.geocodePostalCode("28195");
    expect(result).toMatchObject({ latitude: 53.0758, longitude: 8.8072, precision: "POSTAL_CODE" });
    // A postal code sent as `q` can match a house number in another country.
    expect(calls[0]).toContain("postalcode=28195");
    expect(calls[0]).toContain("country=de");
    expect(calls[0]).not.toContain("q=");
  });

  it("sends the identifying agent the service requires", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const maps = new OpenStreetMapMaps({
      userAgent: "rescue-test/1.0 (test@example.com)",
      fetcher: async (_url, init) => {
        seen.push(init?.headers);
        return { ok: true, status: 200, json: async () => BREMEN_MITTE };
      }
    });
    await maps.geocodePostalCode("28195");
    expect(seen[0]?.["user-agent"]).toBe("rescue-test/1.0 (test@example.com)");
  });

  it("sends OSRM coordinates as lon,lat", async () => {
    const { fetcher, calls } = fetcherReturning({
      "/search?postalcode=28195": BREMEN_MITTE,
      "/search?postalcode=28757": BREMEN_NORD,
      "/route/": { routes: [{ distance: 18_400, duration: 1_500 }] }
    });
    const maps = new OpenStreetMapMaps({ userAgent: "rescue-test/1.0 (t@e.com)", fetcher });

    const route = await maps.route("28195", "28757");
    const routeCall = calls.find((call) => call.includes("/route/"))!;
    // Longitude first. A transposition here produces a plausible-looking
    // route rather than an error, which is why it gets its own assertion.
    expect(routeCall).toContain("8.8072,53.0758;8.6222,53.1675");
    expect(route).toMatchObject({ distanceKm: 18.4, durationMinutes: 25, isRoadDistance: true });
  });

  it("refuses anything that is not a five-digit German postal code", async () => {
    const maps = new OpenStreetMapMaps({ userAgent: "rescue-test/1.0 (t@e.com)", fetcher: async () => ({ ok: true, status: 200, json: async () => [] }) });
    await expect(maps.geocodePostalCode("Bremen")).rejects.toThrow(/five-digit/i);
    await expect(maps.geocodePostalCode("2819")).rejects.toThrow(/five-digit/i);
  });

  it("throws rather than inventing a coordinate when there is no match", async () => {
    const maps = new OpenStreetMapMaps({
      userAgent: "rescue-test/1.0 (t@e.com)",
      fetcher: async () => ({ ok: true, status: 200, json: async () => [] })
    });
    await expect(maps.geocodePostalCode("99999")).rejects.toThrow(/No coordinate/);
  });

  it("throws on a malformed coordinate rather than passing NaN on", async () => {
    const maps = new OpenStreetMapMaps({
      userAgent: "rescue-test/1.0 (t@e.com)",
      fetcher: async () => ({ ok: true, status: 200, json: async () => [{ lat: "north", lon: "8.8" }] })
    });
    await expect(maps.geocodePostalCode("28195")).rejects.toThrow(/not a number/);
  });

  it("surfaces an error status", async () => {
    const maps = new OpenStreetMapMaps({
      userAgent: "rescue-test/1.0 (t@e.com)",
      fetcher: async () => ({ ok: false, status: 429, json: async () => ({}) })
    });
    await expect(maps.geocodePostalCode("28195")).rejects.toThrow(/429/);
  });
});

describe("the cache keeps us inside the usage policy, and standing when it fails", () => {
  it("asks once for a postal code it has already seen", async () => {
    const { fetcher, calls } = fetcherReturning({ "/search": BREMEN_MITTE });
    const maps = new CachingMaps(
      new OpenStreetMapMaps({ userAgent: "rescue-test/1.0 (t@e.com)", fetcher }),
      { now: () => NOW.now() }
    );

    await maps.geocodePostalCode("28195");
    await maps.geocodePostalCode("28195");
    await maps.geocodePostalCode("28195");
    expect(calls).toHaveLength(1);
  });

  it("asks again once the entry is stale", async () => {
    const clock = new FixedClock(new Date("2026-09-19T08:00:00.000Z"));
    const { fetcher, calls } = fetcherReturning({ "/search": BREMEN_MITTE });
    const maps = new CachingMaps(
      new OpenStreetMapMaps({ userAgent: "rescue-test/1.0 (t@e.com)", fetcher }),
      { now: () => clock.now(), ttlMs: 60_000 }
    );

    await maps.geocodePostalCode("28195");
    clock.advance(61_000);
    await maps.geocodePostalCode("28195");
    expect(calls).toHaveLength(2);
  });

  it("falls back to the estimate when the provider is down, and says so", async () => {
    const onFallback = vi.fn();
    const maps = new CachingMaps(
      new OpenStreetMapMaps({
        userAgent: "rescue-test/1.0 (t@e.com)",
        fetcher: async () => {
          throw new Error("network down");
        }
      }),
      { now: () => NOW.now(), onFallback }
    );

    const route = await maps.route("28195", "28309");
    // An answer, not an exception: the eligibility gate has to produce a
    // shortlist even when a third party is unreachable.
    expect(route.distanceKm).toBeGreaterThan(0);
    // And the flag is false, so nothing downstream calls it a road distance.
    expect(route.isRoadDistance).toBe(false);
    expect(onFallback).toHaveBeenCalled();
  });

  it("does not remember a failure for a week", async () => {
    let fail = true;
    const maps = new CachingMaps(
      {
        kind: "osm",
        geocodePostalCode: async () => {
          throw new Error("nope");
        },
        route: async () => {
          if (fail) throw new Error("nope");
          return { distanceKm: 12.3, durationMinutes: 20, isRoadDistance: true, provider: "osm" };
        }
      },
      { now: () => NOW.now() }
    );

    expect((await maps.route("28195", "28309")).isRoadDistance).toBe(false);
    fail = false;
    expect((await maps.route("28195", "28309")).isRoadDistance).toBe(true);
  });
});

/**
 * The live check.
 *
 * Off by default. Run it with MAPS_LIVE=1 to prove the adapter against the
 * real services -- which is the only way to know the request shape is right,
 * since a substituted transport will happily agree with a wrong URL.
 */
const live = process.env.MAPS_LIVE === "1";
describe.runIf(live)("against the real OpenStreetMap services", () => {
  const maps = new OpenStreetMapMaps({
    userAgent: process.env.MAPS_USER_AGENT ?? "rescue-live-test/1.0 (dev@builtwithcca.com)",
    timeoutMs: 15_000
  });

  it("geocodes a Bremen postal code", { timeout: 30_000 }, async () => {
    const result = await maps.geocodePostalCode("28195");
    // Bremen city centre, give or take.
    expect(result.latitude).toBeGreaterThan(53.0);
    expect(result.latitude).toBeLessThan(53.2);
    expect(result.longitude).toBeGreaterThan(8.6);
    expect(result.longitude).toBeLessThan(9.0);
  });

  it("routes between two Bremen postal codes by road", { timeout: 30_000 }, async () => {
    // Nominatim asks for at most one request a second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const route = await maps.route("28195", "28757");
    expect(route.isRoadDistance).toBe(true);
    // Mitte to Vegesack is about 20km by road and nothing like it as the crow
    // flies, which is the whole point of using a router.
    expect(route.distanceKm).toBeGreaterThan(10);
    expect(route.distanceKm).toBeLessThan(45);
    expect(route.durationMinutes).toBeGreaterThan(10);
  });
});
