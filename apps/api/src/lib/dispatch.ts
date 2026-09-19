import type { EligibilityResult, Job } from "@rescue/contracts";
import { demandFromItems, rankProviders, type EligibilityProvider } from "./eligibility.js";
import { MINUTE_MS, type Clock } from "./clock.js";
import type { Actor, Store } from "../store/types.js";

/**
 * Dispatch automation.
 *
 * Two things live here. `rankForJob` is the eligibility read, shared by the
 * dispatcher's own view and by the sweep, so a provider the console shows as
 * eligible is exactly the one automation would pick. `DispatchSweep` is the
 * periodic job that expires stale offers and covers the jobs they leave
 * uncovered.
 *
 * The automation is deliberately bounded. It re-offers to providers that have
 * not yet been asked, a fixed number of rounds, and then stops and escalates
 * to a human. An unbounded retry loop would keep a job "in progress" forever
 * while nobody was actually coming; a bounded one fails loudly, which is the
 * behaviour a dispatcher can plan around.
 *
 * Nothing here moves a job between states. Expiry changes offers, re-offering
 * creates offers, escalation records an event. The job itself only moves when
 * a provider accepts or a person acts -- see `tests/human-in-the-loop.test.ts`.
 */

/** Assembles the eligibility inputs for every provider in the system. */
export async function loadEligibilityProviders(store: Store): Promise<EligibilityProvider[]> {
  const providers = await store.listProviders({});
  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      status: provider.status,
      acceptingWork: provider.acceptingWork,
      basePostalCode: provider.basePostalCode,
      serviceRadiusKm: provider.serviceRadiusKm,
      serviceTypes: provider.serviceTypes as EligibilityProvider["serviceTypes"],
      vehicles: await store.listVehicles(provider.id),
      documents: (await store.listDocuments(provider.id)).map((document) => ({
        type: document.type as EligibilityProvider["documents"][number]["type"],
        status: document.status,
        expiresAt: document.expiresAt
      }))
    }))
  );
}

/** Every provider, ranked for this job, with a reason for each exclusion. */
export async function rankForJob(
  store: Store,
  job: Job,
  now: Date
): Promise<EligibilityResult[]> {
  return rankProviders(
    await loadEligibilityProviders(store),
    {
      jobType: job.type,
      pickupPostalCode: job.pickup.postalCode,
      requiredVehicleClass: "SMALL_VAN",
      ...demandFromItems(job.items)
    },
    now
  );
}

export interface SweepConfig {
  /** How many providers a single round is offered to. */
  providersPerRound: number;
  /** How long each automatically created offer lives. */
  offerTtlMinutes: number;
  /**
   * Rounds of automatic re-offering before a human is asked.
   *
   * Counted in rounds rather than providers, so a job in a thin area where
   * each round finds one provider gets as many tries as one in a dense area.
   * The dispatcher's own first round does not count against it.
   */
  maxRounds: number;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  providersPerRound: 3,
  offerTtlMinutes: 20,
  maxRounds: 3
};

export interface SweepResult {
  expired: number;
  /** Jobs that were offered to a fresh set of providers. */
  reoffered: string[];
  /** Jobs handed back to a human, with the reason. */
  escalated: { jobId: string; reason: string }[];
}

export class DispatchSweep {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      config?: Partial<SweepConfig>;
    }
  ) {}

  private get config(): SweepConfig {
    return { ...DEFAULT_SWEEP_CONFIG, ...this.deps.config };
  }

  async run(actor: Actor): Promise<SweepResult> {
    const now = this.deps.clock.now();
    const { expired, jobIds } = await this.deps.store.expireOffers(now, actor);

    const result: SweepResult = { expired, reoffered: [], escalated: [] };
    for (const jobId of jobIds) {
      const outcome = await this.cover(jobId, actor);
      if (outcome.kind === "reoffered") result.reoffered.push(jobId);
      if (outcome.kind === "escalated") result.escalated.push({ jobId, reason: outcome.reason });
    }
    return result;
  }

  /**
   * Tries to put a fresh round of offers on one uncovered job.
   *
   * Every early return is a case where doing nothing is correct: the job moved
   * on, somebody is already holding it, or a live offer is still outstanding.
   * Re-offering in any of those would create a second claimant on work that
   * already has one.
   */
  private async cover(
    jobId: string,
    actor: Actor
  ): Promise<{ kind: "skipped" } | { kind: "reoffered" } | { kind: "escalated"; reason: string }> {
    const now = this.deps.clock.now();
    const job = await this.deps.store.findJob(jobId, { kind: "staff" });
    if (!job || job.status !== "QUOTED") return { kind: "skipped" };

    const assignment = await this.deps.store.findActiveAssignment(jobId);
    if (assignment) return { kind: "skipped" };

    const offers = await this.deps.store.listOffersForJob(jobId);
    if (offers.some((offer) => offer.status === "PENDING")) return { kind: "skipped" };

    // A job is only dispatchable against a price the customer agreed to. The
    // sweep is held to the same rule as the dispatcher's own button.
    const quotes = await this.deps.store.listQuotesForJob(jobId, { kind: "staff" });
    const approved = quotes.find((quote) => quote.status === "APPROVED");
    if (!approved) return { kind: "skipped" };

    const automaticRounds = this.automaticRoundsSoFar(offers.length);
    if (automaticRounds >= this.config.maxRounds) {
      return this.escalate(jobId, "MAX_ROUNDS_REACHED", actor, { rounds: automaticRounds });
    }

    const alreadyAsked = new Set(offers.map((offer) => offer.providerId));
    const ranked = await rankForJob(this.deps.store, job, now);
    const next = ranked
      .filter((candidate) => candidate.eligible && !alreadyAsked.has(candidate.providerId))
      .slice(0, this.config.providersPerRound);

    if (next.length === 0) {
      return this.escalate(jobId, "NO_ELIGIBLE_PROVIDER_LEFT", actor, {
        alreadyAsked: alreadyAsked.size
      });
    }

    // The payout carries over from the last round. Raising it automatically
    // would be a pricing decision, and pricing is a dispatcher's to make.
    const payoutNetCents = offers.at(-1)?.payoutNetCents ?? Math.round(approved.netCents * 0.72);

    await this.deps.store.createOffers({
      jobId,
      providerIds: next.map((candidate) => candidate.providerId),
      payoutNetCents,
      expiresAt: new Date(now.getTime() + this.config.offerTtlMinutes * MINUTE_MS),
      actor
    });
    return { kind: "reoffered" };
  }

  /**
   * How many rounds the sweep itself has already run on this job.
   *
   * The dispatcher's own first round is not one of them: the allowance is for
   * automatic retries, and spending it on the human's deliberate act would
   * mean a `maxRounds` of one never retried at all.
   */
  private automaticRoundsSoFar(offerCount: number): number {
    return Math.max(0, Math.ceil(offerCount / this.config.providersPerRound) - 1);
  }

  private async escalate(
    jobId: string,
    reason: string,
    actor: Actor,
    payload: Record<string, unknown>
  ): Promise<{ kind: "escalated"; reason: string }> {
    // An event rather than a state change: the job has not moved, a person now
    // needs to look at it. The outbox turns this into a dispatcher alert.
    await this.deps.store.recordJobEvent({
      jobId,
      type: "DISPATCH_ESCALATED",
      payload: { ...payload, reason },
      actor
    });
    return { kind: "escalated", reason };
  }
}
