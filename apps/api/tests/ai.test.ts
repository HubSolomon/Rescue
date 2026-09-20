import { afterEach, describe, expect, it, vi } from "vitest";
import { LOW_CONFIDENCE_BELOW } from "@rescue/contracts";
import { FixedClock } from "../src/lib/clock.js";
import { isLowConfidence, StubTriageModel, ValidatingTriageService } from "../src/lib/ai.js";
import { harness, idem, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

/**
 * Model-produced suggestions.
 *
 * The interesting cases are all the ones where the model is wrong: it answers
 * with the wrong shape, with an impossible value, with a field it has no
 * business setting, or not at all. In every one of them the system must end up
 * with a suggestion a dispatcher can act on and an honest record of where it
 * came from.
 */

const CLOCK = () => new FixedClock(new Date("2026-09-19T08:00:00.000Z"));

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("a model's answer is validated before anyone sees it", () => {
  it("accepts a well-formed answer and keeps its provenance", async () => {
    const service = new ValidatingTriageService({ model: new StubTriageModel(), clock: CLOCK() });
    const { suggestion, provenance } = await service.suggestWithProvenance(VALID_JOB);

    expect(suggestion.vehicleClass).toBeDefined();
    expect(provenance.fellBackToRules).toBe(false);
    expect(provenance.promptId).toBe("triage.vehicle-and-team");
    expect(provenance.promptVersion).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(provenance.model).toBe("stub");
  });

  it("discards an answer of the wrong shape and uses the rules instead", async () => {
    const onFallback = vi.fn();
    const service = new ValidatingTriageService({
      model: new StubTriageModel({ output: { vehicleClass: "HOVERCRAFT" }, confidence: 0.99 }),
      clock: CLOCK(),
      onFallback
    });

    const { suggestion, provenance } = await service.suggestWithProvenance(VALID_JOB);

    // Not coerced, not partially accepted: the rules answered.
    expect(provenance.fellBackToRules).toBe(true);
    expect(provenance.model).toBe("rules");
    expect(suggestion.vehicleClass).not.toBe("HOVERCRAFT");
    expect(onFallback).toHaveBeenCalledWith(
      "the model's answer did not fit the schema",
      expect.anything()
    );
  });

  it("does not let a high stated confidence rescue a malformed answer", async () => {
    const service = new ValidatingTriageService({
      model: new StubTriageModel({ output: { nonsense: true }, confidence: 1 }),
      clock: CLOCK()
    });
    const { provenance } = await service.suggestWithProvenance(VALID_JOB);
    expect(provenance.fellBackToRules).toBe(true);
    // The confidence reported is the rules engine's own, not the model's
    // claim about an answer that was thrown away.
    expect(provenance.confidence).toBeLessThan(1);
  });

  it("falls back when the model is unreachable", async () => {
    const onFallback = vi.fn();
    const service = new ValidatingTriageService({
      model: new StubTriageModel(() => {
        throw new Error("model timed out");
      }),
      clock: CLOCK(),
      onFallback
    });

    const { suggestion, provenance } = await service.suggestWithProvenance(VALID_JOB);
    expect(suggestion.requiresHumanApproval).toBe(true);
    expect(provenance.fellBackToRules).toBe(true);
    expect(onFallback).toHaveBeenCalledWith("the model call failed", expect.anything());
  });

  it("works with no model at all", async () => {
    const service = new ValidatingTriageService({ model: null, clock: CLOCK() });
    const { suggestion, provenance } = await service.suggestWithProvenance(VALID_JOB);
    expect(suggestion.vehicleClass).toBeDefined();
    expect(provenance.model).toBe("rules");
  });
});

describe("the model cannot grant itself authority", () => {
  it("requiresHumanApproval is true even when the model says otherwise", async () => {
    const service = new ValidatingTriageService({
      model: new StubTriageModel({
        output: {
          vehicleClass: "SMALL_VAN",
          workers: 1,
          estimatedMinutes: 45,
          circularRoute: "DELIVER",
          risks: [],
          confidence: 1,
          // The model asserting it does not need a person.
          requiresHumanApproval: false
        },
        confidence: 1
      }),
      clock: CLOCK()
    });

    const { suggestion } = await service.suggestWithProvenance(VALID_JOB);
    expect(suggestion.requiresHumanApproval).toBe(true);
  });

  it("confidence is clamped to a probability", async () => {
    const service = new ValidatingTriageService({
      model: new StubTriageModel({
        output: {
          vehicleClass: "SMALL_VAN",
          workers: 1,
          estimatedMinutes: 45,
          circularRoute: "DELIVER",
          risks: [],
          confidence: 0.5,
          requiresHumanApproval: true
        },
        confidence: 4.2
      }),
      clock: CLOCK()
    });
    const { provenance } = await service.suggestWithProvenance(VALID_JOB);
    expect(provenance.confidence).toBe(1);
  });

  it("low confidence changes what a dispatcher is told, and nothing else", () => {
    const base = {
      promptId: "p",
      promptVersion: "1",
      model: "m",
      latencyMs: 10,
      fellBackToRules: false,
      generatedAt: new Date().toISOString()
    };
    expect(isLowConfidence({ ...base, confidence: LOW_CONFIDENCE_BELOW - 0.01 })).toBe(true);
    expect(isLowConfidence({ ...base, confidence: LOW_CONFIDENCE_BELOW })).toBe(false);
  });
});

describe("suggestions are recorded against the job", () => {
  it("creating a job stores the suggestion with its provenance", async () => {
    open = await harness();
    const h = open;

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().meta.humanApprovalRequired).toBe(true);
    expect(created.json().meta.provenance.promptId).toBeDefined();

    const jobId = created.json().data.job.id as string;
    const recorded = await h.store.listSuggestions(jobId, { kind: "staff" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("triage");
    expect(recorded[0]!.promptVersion).toBeDefined();
    expect(recorded[0]!.confidence).toBeGreaterThan(0);
  });

  it("a suggestion is recorded even though nobody has acted on it", async () => {
    open = await harness();
    const h = open;
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    // Still DRAFT: no dispatcher has seen it.
    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("DRAFT");
    // The record exists regardless. The audit question is what was proposed.
    expect(await h.store.listSuggestions(jobId, { kind: "staff" })).toHaveLength(1);
  });
});
