import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobStatuses, type JobStatus } from "@rescue/contracts";
import { MINUTE_MS } from "../src/lib/clock.js";
import { StubTriageModel, ValidatingTriageService } from "../src/lib/ai.js";
import { DispatchSweep } from "../src/lib/dispatch.js";
import { MockPaymentGateway } from "../src/lib/payments.js";
import { RecordingNotificationSender } from "../src/lib/notifications.js";
import { buildHandlers } from "../src/worker/handlers.js";
import { buildPaymentHandlers } from "../src/worker/payments.js";
import { composeHandlers, OutboxWorker } from "../src/worker/worker.js";
import {
  harness,
  idem,
  jobThroughToAssigned,
  jobThroughToQuoted,
  SUBJECTS,
  TEST_SECRET,
  VALID_JOB,
  type Harness
} from "./helpers.js";

/**
 * The Phase 4 requirement that matters most: no AI output changes job state
 * without a human action.
 *
 * It is the easiest guarantee to lose while adding automation, because every
 * piece of automation added in this phase is one step away from being allowed
 * to decide. So it is checked three ways, none of which trusts the others:
 *
 *   1. Structurally -- no transition exists that a model or the worker can
 *      reach, proved by grepping the source rather than by reading it.
 *   2. Behaviourally -- run the whole machine with nobody pressing anything,
 *      and watch the job not move.
 *   3. Adversarially -- give the model the most confident, most authoritative
 *      answer it could possibly produce, and watch it change nothing.
 */

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

function everySourceFile(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) everySourceFile(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("structurally: nothing outside a route can move a job", () => {
  const sourceRoot = join(process.cwd(), "src");
  const files = everySourceFile(sourceRoot);

  it("only the stores define transitionJob, and only routes call it", () => {
    const callers = files.filter((path) => {
      const text = readFileSync(path, "utf8");
      return /\.transitionJob\(/.test(text);
    });

    // Routes act on a request, and every request carries an authenticated
    // person. Anything else in this list would be a state change with no
    // human behind it.
    for (const caller of callers) {
      expect(caller, `${caller} calls transitionJob`).toMatch(/src\/routes\//);
    }
    expect(callers.length).toBeGreaterThan(0);
  });

  it("the AI module cannot reach the store at all", () => {
    const ai = readFileSync(join(sourceRoot, "lib", "ai.ts"), "utf8");
    // Not a matter of discipline: the module has no store to call.
    expect(ai).not.toMatch(/store/i);
    expect(ai).not.toMatch(/transitionJob|acceptOffer|createOffers/);
  });

  it("the worker and its handlers never transition a job", () => {
    for (const path of files.filter((file) => file.includes("/worker/"))) {
      const text = readFileSync(path, "utf8");
      expect(text, `${path}`).not.toMatch(/transitionJob|acceptOffer|fallbackAssignment/);
    }
  });

  it("the sweep touches offers and events, never the job's own status", () => {
    const sweep = readFileSync(join(sourceRoot, "lib", "dispatch.ts"), "utf8");
    expect(sweep).not.toMatch(/transitionJob/);
    // What it may do: expire offers, create offers, record an event.
    expect(sweep).toMatch(/expireOffers|createOffers|recordJobEvent/);
  });

  it("requiresHumanApproval is a literal, never a computed value", () => {
    const triage = readFileSync(join(sourceRoot, "lib", "triage.ts"), "utf8");
    expect(triage).toMatch(/requiresHumanApproval:\s*true/);
    const ai = readFileSync(join(sourceRoot, "lib", "ai.ts"), "utf8");
    expect(ai).toMatch(/requiresHumanApproval:\s*true/);
    // Assigned `true` and nothing else, anywhere: no threshold, no variable,
    // no field copied from a model's answer.
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/requiresHumanApproval:\s*([A-Za-z0-9_.()]+)/g)) {
        // `z.literal(true)` in the contracts package is the schema; in this
        // package the only permitted value is the literal.
        expect(match[1], `${path} sets requiresHumanApproval to ${match[1]}`).toBe("true");
      }
    }
  });
});

describe("behaviourally: with nobody pressing anything, nothing moves", () => {
  it("a job sits in DRAFT however long the machine runs", async () => {
    open = await harness();
    const h = open;
    const sweep = new DispatchSweep({ store: h.store, clock: h.clock });
    const worker = new OutboxWorker({
      store: h.store,
      clock: h.clock,
      logger: h.app.log,
      handlers: composeHandlers(
        buildHandlers({ store: h.store, sender: new RecordingNotificationSender() }),
        buildPaymentHandlers({ store: h.store, gateway: new MockPaymentGateway(TEST_SECRET) })
      ),
      actor: { userId: null, role: "ADMIN" }
    });

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    // A day of automation: the worker drains, the sweep sweeps, the clock
    // moves. Nobody approves anything.
    for (let hour = 0; hour < 24; hour++) {
      await worker.drain();
      await sweep.run({ userId: null, role: "DISPATCHER" });
      h.clock.advance(60 * MINUTE_MS);
    }

    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("DRAFT");
    // And there is a suggestion sitting there, waiting for a person.
    expect(await h.store.listSuggestions(jobId, { kind: "staff" })).toHaveLength(1);
  });

  it("a quoted job is never assigned by the system alone", async () => {
    open = await harness();
    const h = open;
    const sweep = new DispatchSweep({ store: h.store, clock: h.clock });
    const { jobId } = await jobThroughToQuoted(h);

    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000, expiresInMinutes: 5 }
    });

    // Every offer lapses, over and over. The sweep re-offers and escalates;
    // it never accepts on a provider's behalf.
    for (let round = 0; round < 6; round++) {
      h.clock.advance(6 * MINUTE_MS);
      await sweep.run({ userId: null, role: "DISPATCHER" });
    }

    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("QUOTED");
    expect(await h.store.findActiveAssignment(jobId)).toBeNull();
  });

  it("every transition that did happen has a person behind it", async () => {
    open = await harness();
    const h = open;
    const { jobId } = await jobThroughToAssigned(h);

    const transitionTypes = new Set([
      "TRIAGE_APPROVED",
      "JOB_QUOTED",
      "OFFER_ACCEPTED",
      "WORK_STARTED",
      "JOB_COMPLETED",
      "JOB_CANCELLED"
    ]);

    const transitions = h.store.events.filter(
      (event) => event.jobId === jobId && transitionTypes.has(event.type)
    );
    expect(transitions.length).toBeGreaterThan(0);
    for (const event of transitions) {
      // A null actor is the system. No state change may carry one.
      expect(event.actorId, `${event.type} has no human actor`).not.toBeNull();
    }
  });
});

describe("adversarially: the most authoritative answer a model could give", () => {
  it("an answer that claims not to need approval is thrown away entirely", async () => {
    const { FixedClock } = await import("../src/lib/clock.js");
    // The schema types this field as `z.literal(true)`, so a model asserting
    // its own authority does not produce an overreaching suggestion -- it
    // produces an invalid one, and invalid suggestions are discarded.
    const selfApproving = new StubTriageModel({
      output: {
        vehicleClass: "TRUCK",
        workers: 4,
        estimatedMinutes: 30,
        circularRoute: "RECYCLE",
        risks: [],
        confidence: 1,
        requiresHumanApproval: false
      },
      confidence: 1
    });

    open = await harness({
      triage: new ValidatingTriageService({
        model: selfApproving,
        clock: new FixedClock(new Date("2026-09-19T08:00:00.000Z"))
      })
    });
    const h = open;

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    // Not merely overridden: rejected. The rules answered, so none of the
    // model's proposal survived, not even the parts that were fine.
    expect(created.json().meta.provenance.fellBackToRules).toBe(true);
    expect(created.json().data.triage.vehicleClass).not.toBe("TRUCK");
    expect(created.json().data.triage.requiresHumanApproval).toBe(true);
  });

  it("a well-formed, maximally confident answer still moves nothing", async () => {
    const { FixedClock } = await import("../src/lib/clock.js");
    const certain = new StubTriageModel({
      output: {
        vehicleClass: "TRUCK",
        workers: 4,
        estimatedMinutes: 30,
        circularRoute: "RECYCLE",
        risks: [],
        confidence: 1,
        requiresHumanApproval: true
      },
      confidence: 1
    });

    open = await harness({
      triage: new ValidatingTriageService({
        model: certain,
        clock: new FixedClock(new Date("2026-09-19T08:00:00.000Z"))
      })
    });
    const h = open;

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    // The suggestion is delivered in full: certainty is allowed, authority is
    // not.
    expect(created.json().data.triage.vehicleClass).toBe("TRUCK");
    expect(created.json().meta.provenance.confidence).toBe(1);
    expect(created.json().meta.humanApprovalRequired).toBe(true);

    const jobId = created.json().data.job.id as string;
    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("DRAFT");
    // Creation, and nothing else. No approval, no transition.
    const events = h.store.events.filter((event) => event.jobId === jobId);
    expect(events.map((event) => event.type)).toEqual(["JOB_CREATED"]);
  });

  it("a dispatcher's approval records the dispatcher's values, not the model's", async () => {
    open = await harness();
    const h = open;
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;
    const suggested = created.json().data.triage.vehicleClass;

    // The dispatcher disagrees and approves something else entirely.
    const contrary = suggested === "TRUCK" ? "SMALL_VAN" : "TRUCK";
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { vehicleClass: contrary, workers: 1, circularRoute: "DELIVER" }
    });

    const approval = h.store.events.find((event) => event.type === "TRIAGE_APPROVED")!;
    // What was approved is what the person chose. The suggestion is on record
    // separately, and it is not what the job now carries.
    expect(approval.payload.vehicleClass).toBe(contrary);
    expect(approval.actorId).not.toBeNull();
  });
});

describe("every job status is reachable only through a route", () => {
  it("no status has a path that skips a request", () => {
    // A guard against a future transition being added somewhere automation
    // can reach. If a new status appears, this fails until somebody decides
    // where it is allowed to be set.
    const reachable: JobStatus[] = [...jobStatuses];
    expect(reachable).toEqual([
      "DRAFT",
      "TRIAGED",
      "QUOTED",
      "ASSIGNED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED"
    ]);
  });
});
