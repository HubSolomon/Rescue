import { describe, expect, it } from "vitest";
import {
  demandFromItems,
  estimateDistanceKm,
  evaluateProviderEligibility,
  rankProviders,
  selectVehicle,
  vehicleClassRank,
  type EligibilityDemand,
  type EligibilityProvider
} from "../src/lib/eligibility.js";

const NOW = new Date("2026-09-19T08:00:00.000Z");
const NEXT_YEAR = new Date("2027-09-19T08:00:00.000Z");
const LAST_YEAR = new Date("2025-09-19T08:00:00.000Z");

const demand: EligibilityDemand = {
  jobType: "FAILED_DELIVERY",
  pickupPostalCode: "28195",
  requiredVehicleClass: "SMALL_VAN",
  totalWeightKg: 100,
  totalVolumeM3: 2
};

function provider(overrides: Partial<EligibilityProvider> = {}): EligibilityProvider {
  return {
    id: "p-base",
    status: "ACTIVE",
    basePostalCode: "28195",
    serviceRadiusKm: 40,
    serviceTypes: ["FAILED_DELIVERY", "BULKY_RETURN"],
    vehicles: [{ id: "v1", vehicleClass: "LARGE_VAN", payloadKg: 1200, volumeM3: 12, active: true }],
    documents: [
      { type: "LIABILITY_INSURANCE", status: "VERIFIED", expiresAt: NEXT_YEAR },
      { type: "TRADE_LICENCE", status: "VERIFIED", expiresAt: null }
    ],
    ...overrides
  };
}

describe("every exclusion rule fires, and says why", () => {
  it("accepts a fully compliant provider", () => {
    const result = evaluateProviderEligibility(provider(), demand, NOW);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("excludes a provider that is not ACTIVE", () => {
    for (const status of ["PENDING", "SUSPENDED", "REJECTED"] as const) {
      const result = evaluateProviderEligibility(provider({ status }), demand, NOW);
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain("PROVIDER_NOT_ACTIVE");
    }
  });

  it("excludes a provider that does not offer the service type", () => {
    const result = evaluateProviderEligibility(
      provider({ serviceTypes: ["COMPANY_SURPLUS"] }),
      demand,
      NOW
    );
    expect(result.reasons).toContain("SERVICE_TYPE_NOT_PERMITTED");
  });

  it("excludes a provider outside its own service radius", () => {
    const result = evaluateProviderEligibility(
      provider({ basePostalCode: "80331", serviceRadiusKm: 20 }),
      demand,
      NOW
    );
    expect(result.reasons).toContain("OUTSIDE_SERVICE_RADIUS");
  });

  it("excludes a provider missing a required document", () => {
    const result = evaluateProviderEligibility(
      provider({ documents: [{ type: "TRADE_LICENCE", status: "VERIFIED", expiresAt: null }] }),
      demand,
      NOW
    );
    expect(result.reasons).toContain("MISSING_REQUIRED_DOCUMENT");
  });

  it("excludes a provider whose document is submitted but unverified", () => {
    const result = evaluateProviderEligibility(
      provider({
        documents: [
          { type: "LIABILITY_INSURANCE", status: "PENDING", expiresAt: NEXT_YEAR },
          { type: "TRADE_LICENCE", status: "VERIFIED", expiresAt: null }
        ]
      }),
      demand,
      NOW
    );
    expect(result.reasons).toContain("DOCUMENT_NOT_VERIFIED");
  });

  it("excludes on a past expiry even when the status column still says VERIFIED", () => {
    // The nightly expiry sweep may not have run. The date wins.
    const result = evaluateProviderEligibility(
      provider({
        documents: [
          { type: "LIABILITY_INSURANCE", status: "VERIFIED", expiresAt: LAST_YEAR },
          { type: "TRADE_LICENCE", status: "VERIFIED", expiresAt: null }
        ]
      }),
      demand,
      NOW
    );
    expect(result.reasons).toContain("DOCUMENT_EXPIRED");
    expect(result.eligible).toBe(false);
  });

  it("excludes when no vehicle is big enough", () => {
    const tooSmall = provider({
      vehicles: [{ id: "v1", vehicleClass: "CARGO_BIKE", payloadKg: 40, volumeM3: 0.5, active: true }]
    });
    expect(evaluateProviderEligibility(tooSmall, demand, NOW).reasons).toContain("NO_SUITABLE_VEHICLE");
  });

  it("ignores inactive vehicles", () => {
    const parked = provider({
      vehicles: [{ id: "v1", vehicleClass: "TRUCK", payloadKg: 7000, volumeM3: 40, active: false }]
    });
    expect(evaluateProviderEligibility(parked, demand, NOW).reasons).toContain("NO_SUITABLE_VEHICLE");
  });

  it("reports every applicable reason, not just the first", () => {
    const hopeless = provider({
      status: "SUSPENDED",
      serviceTypes: ["COMPANY_SURPLUS"],
      vehicles: [],
      documents: []
    });
    const result = evaluateProviderEligibility(hopeless, demand, NOW);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "PROVIDER_NOT_ACTIVE",
        "SERVICE_TYPE_NOT_PERMITTED",
        "MISSING_REQUIRED_DOCUMENT",
        "NO_SUITABLE_VEHICLE"
      ])
    );
  });
});

describe("vehicle selection picks the smallest sufficient vehicle", () => {
  it("prefers a van over a truck for a small load", () => {
    const fleet = [
      { id: "truck", vehicleClass: "TRUCK" as const, payloadKg: 7000, volumeM3: 40, active: true },
      { id: "van", vehicleClass: "SMALL_VAN" as const, payloadKg: 800, volumeM3: 6, active: true }
    ];
    expect(selectVehicle(fleet, demand)?.id).toBe("van");
  });

  it("falls back to the larger vehicle when the small one cannot carry it", () => {
    const fleet = [
      { id: "truck", vehicleClass: "TRUCK" as const, payloadKg: 7000, volumeM3: 40, active: true },
      { id: "van", vehicleClass: "SMALL_VAN" as const, payloadKg: 50, volumeM3: 1, active: true }
    ];
    expect(selectVehicle(fleet, demand)?.id).toBe("truck");
  });

  it("orders classes by capability", () => {
    expect(vehicleClassRank("CARGO_BIKE")).toBeLessThan(vehicleClassRank("SMALL_VAN"));
    expect(vehicleClassRank("BOX_VAN")).toBeLessThan(vehicleClassRank("TRUCK"));
  });
});

describe("ranking is deterministic", () => {
  const near = provider({ id: "p-near", basePostalCode: "28195" });
  const far = provider({ id: "p-far", basePostalCode: "28309", serviceRadiusKm: 100 });
  const blocked = provider({ id: "p-blocked", status: "SUSPENDED" });

  it("puts the closest eligible provider first and numbers the ranks", () => {
    const results = rankProviders([far, near, blocked], demand, NOW);
    expect(results[0]!.providerId).toBe("p-near");
    expect(results[0]!.rank).toBe(1);
    expect(results[1]!.providerId).toBe("p-far");
    expect(results[1]!.rank).toBe(2);
  });

  it("returns ineligible providers last, with reasons and no rank", () => {
    const results = rankProviders([far, near, blocked], demand, NOW);
    const last = results.at(-1)!;
    expect(last.providerId).toBe("p-blocked");
    expect(last.eligible).toBe(false);
    expect(last.rank).toBeNull();
    expect(last.reasons).toContain("PROVIDER_NOT_ACTIVE");
  });

  it("gives the same answer regardless of input order", () => {
    const a = rankProviders([near, far, blocked], demand, NOW).map((r) => r.providerId);
    const b = rankProviders([blocked, far, near], demand, NOW).map((r) => r.providerId);
    const c = rankProviders([far, blocked, near], demand, NOW).map((r) => r.providerId);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("breaks a full tie on provider id, so ordering never wobbles", () => {
    const one = provider({ id: "aaa" });
    const two = provider({ id: "bbb" });
    expect(rankProviders([two, one], demand, NOW).map((r) => r.providerId)).toEqual(["aaa", "bbb"]);
  });
});

describe("distance estimate", () => {
  it("is zero for the same postal code and grows as prefixes diverge", () => {
    expect(estimateDistanceKm("28195", "28195")).toBe(0);
    expect(estimateDistanceKm("28195", "28199")).toBe(3); // four digits shared
    expect(estimateDistanceKm("28195", "28185")).toBe(10); // three
    expect(estimateDistanceKm("28195", "28295")).toBe(40); // two
    expect(estimateDistanceKm("28195", "20195")).toBe(120); // one
    expect(estimateDistanceKm("28195", "80331")).toBe(400);
  });

  it("is symmetric", () => {
    expect(estimateDistanceKm("28195", "80331")).toBe(estimateDistanceKm("80331", "28195"));
  });
});

describe("demand derived from items", () => {
  it("assumes 50 kg for an item with no weight, and says so via the total", () => {
    expect(demandFromItems([{ quantity: 2 }]).totalWeightKg).toBe(100);
  });

  it("multiplies by quantity", () => {
    expect(demandFromItems([{ quantity: 3, estimatedWeightKg: 10 }]).totalWeightKg).toBe(30);
  });

  it("converts dimensions to cubic metres", () => {
    const result = demandFromItems([
      { quantity: 1, estimatedWeightKg: 10, dimensionsCm: { length: 100, width: 100, height: 100 } }
    ]);
    expect(result.totalVolumeM3).toBe(1);
  });

  it("rounds volume up, never down, so a van is never undersized", () => {
    const result = demandFromItems([
      { quantity: 1, estimatedWeightKg: 1, dimensionsCm: { length: 101, width: 100, height: 100 } }
    ]);
    expect(result.totalVolumeM3).toBeGreaterThanOrEqual(1.01);
  });
});
