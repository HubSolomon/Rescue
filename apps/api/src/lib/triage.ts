import type { CreateJobInput, TriageSuggestion } from "@rescue/contracts";

export interface TriageService { suggest(input: CreateJobInput): Promise<TriageSuggestion>; }

export class RulesFirstTriageService implements TriageService {
  async suggest(input: CreateJobInput): Promise<TriageSuggestion> {
    const totalWeight = input.items.reduce((sum, item) => sum + (item.estimatedWeightKg ?? 50) * item.quantity, 0);
    const workers = totalWeight > 90 || input.stairs > 0 ? 2 : 1;
    const vehicleClass = totalWeight > 1000 ? "MANUAL_REVIEW" : totalWeight > 450 ? "BOX_VAN" : totalWeight > 120 ? "LARGE_VAN" : "SMALL_VAN";
    const circularRoute = input.type === "BULKY_RETURN" ? "RETURN" : input.type === "COMPANY_SURPLUS" ? "REUSE" : "DELIVER";
    const risks: string[] = [];
    if (input.stairs > 2 && !input.liftAvailable) risks.push("Manual carrying assessment required");
    if (input.items.some((item) => item.estimatedWeightKg === undefined)) risks.push("One or more item weights are estimates");
    if (!input.destination) risks.push("Destination requires dispatcher confirmation");
    return { vehicleClass, workers, estimatedMinutes: 45 + input.items.length * 10 + input.stairs * 8, circularRoute, risks, confidence: risks.length ? 0.62 : 0.82, requiresHumanApproval: true };
  }
}
