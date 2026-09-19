import { buildApp, type BuildAppOptions } from "../src/app.js";
import { parseConfig, type Config } from "../src/config.js";
import { DevTokenIssuer } from "../src/lib/auth/verifier.js";
import { FixedClock } from "../src/lib/clock.js";
import { MemoryStore } from "../src/store/memory.js";
import { developmentSeed } from "../src/seed.js";

export const SUBJECTS = {
  customerAdmin: "dev|customer-admin",
  customerMember: "dev|customer-member",
  otherCustomer: "dev|other-customer",
  dispatcher: "dev|dispatcher",
  compliance: "dev|compliance",
  providerHansa: "dev|provider-hansa",
  providerRoland: "dev|provider-roland",
  admin: "dev|admin"
} as const;

export {
  ORG_NORDLICHT,
  ORG_WESERTECH,
  PROVIDER_HANSA,
  PROVIDER_ROLAND,
  PROVIDER_PENDING
} from "../src/seed.js";

export const TEST_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return parseConfig({
    NODE_ENV: "test",
    JWT_SECRET: TEST_SECRET,
    REGISTRATION_HASH_KEY: TEST_SECRET,
    ...overrides
  });
}

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>;
  store: MemoryStore;
  clock: FixedClock;
  config: Config;
  token(subject: string): Promise<string>;
  auth(subject: string): Promise<Record<string, string>>;
  close(): Promise<void>;
}

/** A booted API with the development seed, a fixed clock and an in-memory store. */
export async function harness(options: Partial<BuildAppOptions> = {}): Promise<Harness> {
  const config = (options.config as Config | undefined) ?? testConfig();
  const store = (options.store as MemoryStore | undefined) ?? new MemoryStore(developmentSeed);
  const clock = (options.clock as FixedClock | undefined) ?? new FixedClock(new Date("2026-09-19T08:00:00.000Z"));
  const app = await buildApp({ ...options, config, store, clock });
  const issuer = new DevTokenIssuer(config.JWT_SECRET);

  return {
    app,
    store,
    clock,
    config,
    async token(subject: string) {
      return (await issuer.issue(subject, 3600)).token;
    },
    async auth(subject: string) {
      return { authorization: `Bearer ${(await issuer.issue(subject, 3600)).token}` };
    },
    async close() {
      await app.close();
    }
  };
}

/** A unique Idempotency-Key header, since mutations require one. */
let keyCounter = 0;
export function idem(): Record<string, string> {
  keyCounter += 1;
  return { "idempotency-key": `test-key-${keyCounter}-${Math.random().toString(36).slice(2)}` };
}

export const VALID_JOB = {
  type: "FAILED_DELIVERY" as const,
  urgency: "SAME_DAY" as const,
  pickup: { line1: "Am Markt 1", postalCode: "28195", city: "Bremen", countryCode: "DE" as const },
  destination: { line1: "Parkallee 10", postalCode: "28209", city: "Bremen", countryCode: "DE" as const },
  items: [{ name: "Sofa", quantity: 1, estimatedWeightKg: 85 }],
  stairs: 2,
  liftAvailable: false,
  customerReference: "REF-1",
  notes: "Gate code 4471."
};

/**
 * Drives a job to QUOTED with the quote approved: the state from which a
 * dispatcher may offer it, and therefore the state eligibility is evaluated in.
 */
export async function jobThroughToQuoted(h: Harness) {
  const customer = await h.auth(SUBJECTS.customerAdmin);
  const dispatcher = await h.auth(SUBJECTS.dispatcher);

  const created = await h.app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { ...customer, ...idem() },
    payload: VALID_JOB
  });
  const jobId = created.json().data.job.id as string;

  await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/triage`,
    headers: dispatcher,
    payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
  });

  const quoted = await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/quotes`,
    headers: { ...dispatcher, ...idem() },
    payload: { netCents: 25_000 }
  });
  const quoteId = quoted.json().data.quote.id as string;

  await h.app.inject({
    method: "POST",
    url: `/v1/quotes/${quoteId}/decision`,
    headers: { ...customer, ...idem() },
    payload: { decision: "APPROVE" }
  });

  return { jobId, quoteId };
}

/** Drives a job from creation to ASSIGNED, returning the ids involved. */
export async function jobThroughToAssigned(h: Harness) {
  const dispatcher = await h.auth(SUBJECTS.dispatcher);
  const provider = await h.auth(SUBJECTS.providerHansa);
  const { jobId, quoteId } = await jobThroughToQuoted(h);

  const offers = await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/offers`,
    headers: { ...dispatcher, ...idem() },
    payload: { payoutNetCents: 18_000 }
  });
  const offerList = offers.json().data as { id: string; providerId: string }[];
  const offerId = offerList[0]!.id;

  const accepted = await h.app.inject({
    method: "POST",
    url: `/v1/offers/${offerId}/response`,
    headers: provider,
    payload: { decision: "ACCEPT" }
  });

  return { jobId, quoteId, offerId, offers: offerList, accepted };
}
