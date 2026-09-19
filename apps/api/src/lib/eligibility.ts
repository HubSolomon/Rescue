import {
  REQUIRED_DOCUMENT_TYPES,
  type DocumentStatus,
  type DocumentType,
  type EligibilityResult,
  type IneligibilityReason,
  type JobType,
  type ProviderStatus,
  type VehicleClass
} from "@rescue/contracts";

/**
 * Deterministic provider eligibility.
 *
 * Every rule here is a hard gate evaluated from stored facts. No scoring
 * heuristics, no AI, no randomness: the same inputs always produce the same
 * ordered list, and every exclusion carries a machine-readable reason a
 * dispatcher can read back. AI may later re-rank the *eligible* set, but it
 * can never add a provider this function excluded.
 */

/** Capability order. A larger index can carry everything a smaller one can. */
export const VEHICLE_CLASS_ORDER: readonly VehicleClass[] = [
  "CARGO_BIKE",
  "SMALL_VAN",
  "LARGE_VAN",
  "BOX_VAN",
  "TRUCK"
];

export function vehicleClassRank(vehicleClass: VehicleClass): number {
  return VEHICLE_CLASS_ORDER.indexOf(vehicleClass);
}

export interface EligibilityVehicle {
  id: string;
  vehicleClass: VehicleClass;
  payloadKg: number;
  volumeM3: number;
  active: boolean;
}

export interface EligibilityDocument {
  type: DocumentType;
  status: DocumentStatus;
  expiresAt: Date | null;
}

export interface EligibilityProvider {
  id: string;
  status: ProviderStatus;
  basePostalCode: string;
  serviceRadiusKm: number;
  serviceTypes: readonly JobType[];
  vehicles: readonly EligibilityVehicle[];
  documents: readonly EligibilityDocument[];
}

export interface EligibilityDemand {
  jobType: JobType;
  pickupPostalCode: string;
  requiredVehicleClass: VehicleClass;
  totalWeightKg: number;
  totalVolumeM3: number;
}

/**
 * Placeholder distance model.
 *
 * Phase 4 replaces this with the maps adapter. Until then, distance is derived
 * from German postal-code prefix overlap: deterministic, offline, and biased
 * to overestimate so the radius gate errs toward excluding a provider rather
 * than dispatching one too far away. It is NOT a real road distance and must
 * not be shown to customers as one.
 */
export function estimateDistanceKm(fromPostalCode: string, toPostalCode: string): number {
  if (fromPostalCode === toPostalCode) return 0;
  let shared = 0;
  for (let index = 0; index < 5; index++) {
    if (fromPostalCode[index] !== toPostalCode[index]) break;
    shared++;
  }
  switch (shared) {
    case 4:
      return 3;
    case 3:
      return 10;
    case 2:
      return 40;
    case 1:
      return 120;
    default:
      return 400;
  }
}

function documentProblems(
  documents: readonly EligibilityDocument[],
  now: Date
): IneligibilityReason[] {
  const problems: IneligibilityReason[] = [];
  for (const required of REQUIRED_DOCUMENT_TYPES) {
    const held = documents.filter((document) => document.type === required);
    if (held.length === 0) {
      problems.push("MISSING_REQUIRED_DOCUMENT");
      continue;
    }
    const verified = held.filter((document) => document.status === "VERIFIED");
    if (verified.length === 0) {
      problems.push("DOCUMENT_NOT_VERIFIED");
      continue;
    }
    // A document with no expiry is treated as valid; one that has passed its
    // expiry is not, regardless of the status column, because the nightly
    // expiry sweep may not have run yet.
    const unexpired = verified.filter(
      (document) => document.expiresAt === null || document.expiresAt.getTime() > now.getTime()
    );
    if (unexpired.length === 0) {
      problems.push("DOCUMENT_EXPIRED");
    }
  }
  return problems;
}

/**
 * The smallest active vehicle that can carry the demand, or null. Smallest
 * rather than first so a provider is not ranked on a truck when a small van
 * would do.
 */
export function selectVehicle(
  vehicles: readonly EligibilityVehicle[],
  demand: EligibilityDemand
): EligibilityVehicle | null {
  const required = vehicleClassRank(demand.requiredVehicleClass);
  const suitable = vehicles.filter(
    (vehicle) =>
      vehicle.active &&
      vehicleClassRank(vehicle.vehicleClass) >= required &&
      vehicle.payloadKg >= demand.totalWeightKg &&
      vehicle.volumeM3 >= demand.totalVolumeM3
  );
  if (suitable.length === 0) return null;
  return [...suitable].sort(
    (a, b) =>
      vehicleClassRank(a.vehicleClass) - vehicleClassRank(b.vehicleClass) ||
      a.payloadKg - b.payloadKg ||
      (a.id < b.id ? -1 : 1)
  )[0]!;
}

export function evaluateProviderEligibility(
  provider: EligibilityProvider,
  demand: EligibilityDemand,
  now: Date
): EligibilityResult {
  const reasons: IneligibilityReason[] = [];

  if (provider.status !== "ACTIVE") {
    reasons.push("PROVIDER_NOT_ACTIVE");
  }
  if (!provider.serviceTypes.includes(demand.jobType)) {
    reasons.push("SERVICE_TYPE_NOT_PERMITTED");
  }

  const distanceKm = estimateDistanceKm(provider.basePostalCode, demand.pickupPostalCode);
  if (distanceKm > provider.serviceRadiusKm) {
    reasons.push("OUTSIDE_SERVICE_RADIUS");
  }

  reasons.push(...documentProblems(provider.documents, now));

  if (selectVehicle(provider.vehicles, demand) === null) {
    reasons.push("NO_SUITABLE_VEHICLE");
  }

  return {
    providerId: provider.id,
    eligible: reasons.length === 0,
    reasons,
    rank: null,
    distanceKm
  };
}

/**
 * Evaluates every provider and returns them with eligible ones ranked first.
 * Ineligible providers are returned too, with their reasons, so a dispatcher
 * can see why the list is short instead of staring at an empty screen.
 */
export function rankProviders(
  providers: readonly EligibilityProvider[],
  demand: EligibilityDemand,
  now: Date
): EligibilityResult[] {
  const evaluated = providers.map((provider) => ({
    provider,
    result: evaluateProviderEligibility(provider, demand, now)
  }));

  const eligible = evaluated
    .filter((entry) => entry.result.eligible)
    .sort((a, b) => {
      const byDistance = (a.result.distanceKm ?? 0) - (b.result.distanceKm ?? 0);
      if (byDistance !== 0) return byDistance;
      const vehicleA = selectVehicle(a.provider.vehicles, demand);
      const vehicleB = selectVehicle(b.provider.vehicles, demand);
      const byVehicle =
        vehicleClassRank(vehicleA!.vehicleClass) - vehicleClassRank(vehicleB!.vehicleClass);
      if (byVehicle !== 0) return byVehicle;
      // Stable final tiebreak so the ordering is fully deterministic.
      return a.provider.id < b.provider.id ? -1 : 1;
    })
    .map((entry, index) => ({ ...entry.result, rank: index + 1 }));

  const ineligible = evaluated
    .filter((entry) => !entry.result.eligible)
    .map((entry) => entry.result)
    .sort((a, b) => (a.providerId < b.providerId ? -1 : 1));

  return [...eligible, ...ineligible];
}

/** Total weight in kilograms, treating a missing estimate as 50 kg per unit. */
export function demandFromItems(
  items: readonly { quantity: number; estimatedWeightKg?: number; dimensionsCm?: { length: number; width: number; height: number } }[]
): { totalWeightKg: number; totalVolumeM3: number } {
  let totalWeightKg = 0;
  let totalVolumeM3 = 0;
  for (const item of items) {
    totalWeightKg += (item.estimatedWeightKg ?? 50) * item.quantity;
    if (item.dimensionsCm) {
      const cubicCm = item.dimensionsCm.length * item.dimensionsCm.width * item.dimensionsCm.height;
      totalVolumeM3 += (cubicCm / 1_000_000) * item.quantity;
    } else {
      totalVolumeM3 += 0.5 * item.quantity;
    }
  }
  return {
    totalWeightKg: Math.ceil(totalWeightKg),
    totalVolumeM3: Math.ceil(totalVolumeM3 * 100) / 100
  };
}
