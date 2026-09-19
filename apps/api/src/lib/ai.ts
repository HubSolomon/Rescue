import {
  LOW_CONFIDENCE_BELOW,
  triageSuggestionSchema,
  type CreateJobInput,
  type SuggestionProvenance,
  type TriageSuggestion
} from "@rescue/contracts";
import type { Clock } from "./clock.js";
import { RulesFirstTriageService, type TriageService } from "./triage.js";

/**
 * Model-produced suggestions.
 *
 * Three rules, and they are the point of the whole file:
 *
 * 1. **Nothing leaves here unvalidated.** A model's answer is parsed against
 *    the same Zod schema the rest of the system uses. An answer that does not
 *    fit is not coerced, trimmed or partially accepted -- it is discarded and
 *    the rules engine answers instead. A malformed suggestion that looks
 *    plausible is worse than no suggestion.
 *
 * 2. **Every suggestion carries its provenance.** Prompt id, prompt version,
 *    model, confidence, latency, and whether it came from the model at all.
 *    Six months from now the only way to answer "why did it say a box van" is
 *    to know which prompt and which version produced it.
 *
 * 3. **`requiresHumanApproval` is a literal `true`, always.** Not a field the
 *    model fills in, not a threshold on confidence. Confidence changes what a
 *    dispatcher is *told*; it never changes what the software is allowed to
 *    do. See `tests/human-in-the-loop.test.ts`.
 */

export interface SuggestionResult {
  suggestion: TriageSuggestion;
  provenance: SuggestionProvenance;
}

export interface TriageModel {
  readonly promptId: string;
  readonly promptVersion: string;
  readonly model: string;
  /** Raw, unvalidated model output. Validation happens above, not here. */
  propose(input: CreateJobInput): Promise<{ output: unknown; confidence: number }>;
}

/**
 * Wraps a model with validation, provenance and a rules fallback.
 *
 * The fallback is not an error path taken rarely. It is the normal path
 * whenever the model is slow, unreachable, or answers with something that does
 * not fit the schema -- and the system is designed so that a dispatcher who
 * only ever sees rules output still has everything they need to work.
 */
export class ValidatingTriageService implements TriageService {
  private readonly rules = new RulesFirstTriageService();

  constructor(
    private readonly deps: {
      model: TriageModel | null;
      clock: Clock;
      /** Called with the reason whenever the rules answered instead. */
      onFallback?: (reason: string, detail?: unknown) => void;
    }
  ) {}

  /** The `TriageService` contract: just the suggestion. */
  async suggest(input: CreateJobInput): Promise<TriageSuggestion> {
    return (await this.suggestWithProvenance(input)).suggestion;
  }

  /** The same call, with everything worth recording about how it went. */
  async suggestWithProvenance(input: CreateJobInput): Promise<SuggestionResult> {
    const startedAt = this.deps.clock.now();
    const rulesAnswer = async (reason: string, detail?: unknown): Promise<SuggestionResult> => {
      if (reason !== "no model configured") this.deps.onFallback?.(reason, detail);
      const suggestion = await this.rules.suggest(input);
      return {
        suggestion,
        provenance: {
          promptId: "rules-first",
          promptVersion: "1",
          model: "rules",
          confidence: suggestion.confidence,
          latencyMs: this.deps.clock.now().getTime() - startedAt.getTime(),
          fellBackToRules: true,
          generatedAt: startedAt.toISOString()
        }
      };
    };

    if (!this.deps.model) return rulesAnswer("no model configured");

    let raw: { output: unknown; confidence: number };
    try {
      raw = await this.deps.model.propose(input);
    } catch (error) {
      return rulesAnswer("the model call failed", error);
    }

    const parsed = triageSuggestionSchema.safeParse(raw.output);
    if (!parsed.success) {
      // Deliberately not `.partial()`, not a merge with defaults. A half-valid
      // suggestion is a suggestion nobody can reason about.
      return rulesAnswer("the model's answer did not fit the schema", parsed.error.issues);
    }

    return {
      suggestion: {
        ...parsed.data,
        // Whatever the model returned for this field, it is true. It is not
        // the model's to decide.
        requiresHumanApproval: true
      },
      provenance: {
        promptId: this.deps.model.promptId,
        promptVersion: this.deps.model.promptVersion,
        model: this.deps.model.model,
        confidence: Math.min(1, Math.max(0, raw.confidence)),
        latencyMs: this.deps.clock.now().getTime() - startedAt.getTime(),
        fellBackToRules: false,
        generatedAt: startedAt.toISOString()
      }
    };
  }
}

/** Whether a dispatcher should be told this one is shaky. */
export function isLowConfidence(provenance: SuggestionProvenance): boolean {
  return provenance.confidence < LOW_CONFIDENCE_BELOW;
}

/**
 * A stand-in model for development and tests.
 *
 * It answers with the rules engine's own output and a fixed confidence, so the
 * whole validated path -- propose, parse, record provenance -- is exercised
 * without a network call or a bill. `scripted` lets a test make it answer with
 * anything at all, including nonsense, which is how the validation is proved.
 */
export class StubTriageModel implements TriageModel {
  readonly promptId = "triage.vehicle-and-team";
  readonly promptVersion = "2026-09-19.1";
  readonly model = "stub";
  private readonly rules = new RulesFirstTriageService();

  constructor(
    private readonly scripted?: { output: unknown; confidence: number } | (() => never)
  ) {}

  async propose(input: CreateJobInput): Promise<{ output: unknown; confidence: number }> {
    // A function means "throw", so a test can exercise the unreachable-model
    // path without a network or a timer.
    if (typeof this.scripted === "function") return this.scripted();
    if (this.scripted !== undefined) return this.scripted;
    return { output: await this.rules.suggest(input), confidence: 0.78 };
  }
}
