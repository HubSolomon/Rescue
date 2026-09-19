import type { CreateJobInput, TriageSuggestion } from "@rescue/contracts";
import { demandFromItems, VEHICLE_CLASS_ORDER } from "./eligibility.js";

export interface TriageService {
  suggest(input: CreateJobInput): Promise<TriageSuggestion>;
}

/**
 * Rules-first triage.
 *
 * Deterministic and explainable. An AI adapter may later replace or augment
 * this, but the contract holds either way: `requiresHumanApproval` is a
 * literal `true`, and only a dispatcher moves a job out of DRAFT. Nothing here
 * can approve itself.
 */
export class RulesFirstTriageService implements TriageService {
  async suggest(input: CreateJobInput): Promise<TriageSuggestion> {
    const { totalWeightKg, totalVolumeM3 } = demandFromItems(input.items);

    const workers = totalWeightKg > 90 || input.stairs > 0 ? 2 : 1;

    const vehicleClass =
      totalWeightKg > 1000 || totalVolumeM3 > 40
        ? ("MANUAL_REVIEW" as const)
        : totalWeightKg > 450 || totalVolumeM3 > 15
          ? "BOX_VAN"
          : totalWeightKg > 120 || totalVolumeM3 > 5
            ? "LARGE_VAN"
            : "SMALL_VAN";

    const circularRoute =
      input.type === "BULKY_RETURN" ? "RETURN" : input.type === "COMPANY_SURPLUS" ? "REUSE" : "DELIVER";

    const risks: string[] = [];
    if (input.stairs > 2 && !input.liftAvailable) risks.push("Manual carrying assessment required");
    if (input.items.some((item) => item.estimatedWeightKg === undefined)) {
      risks.push("One or more item weights are estimates");
    }
    if (input.items.some((item) => item.dimensionsCm === undefined)) {
      risks.push("One or more item dimensions are estimates");
    }
    if (!input.destination) risks.push("Destination requires dispatcher confirmation");
    if (vehicleClass === "MANUAL_REVIEW") risks.push("Load exceeds the automatic vehicle-sizing range");

    return {
      vehicleClass,
      workers,
      estimatedMinutes: 45 + input.items.length * 10 + input.stairs * 8,
      circularRoute,
      risks,
      // Confidence falls with the number of unknowns. It is advisory metadata
      // for the dispatcher, never a threshold that authorises anything.
      confidence: Math.max(0.4, 0.85 - risks.length * 0.1),
      requiresHumanApproval: true
    };
  }
}

/** The smallest dispatchable class, used when triage answers MANUAL_REVIEW. */
export const SMALLEST_VEHICLE_CLASS = VEHICLE_CLASS_ORDER[0]!;
