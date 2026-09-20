import { createHmac } from "node:crypto";
import type { LedgerEntryKind, PaymentStatus } from "@rescue/contracts";
import { AppError } from "./errors.js";
import type { StoredLedgerEntry } from "../store/types.js";

/**
 * Money.
 *
 * Four operations, in integer euro cents, behind a port: authorise a
 * customer's card when they approve a quote, capture it when the work is
 * proven done, pay the provider, and refund. Each produces a ledger entry;
 * nothing anywhere keeps a balance, because a stored balance and its entries
 * can disagree and when they do neither can be trusted.
 *
 * The development adapter is deterministic rather than random: the same job
 * always produces the same reference, so a test can assert on it and a
 * developer reading a log can tell two runs apart. It moves no money, and
 * `parseConfig` refuses it in production for the same reason it refuses the
 * mock storage signer.
 */

export interface PaymentIntent {
  jobId: string;
  amountCents: number;
  /** Idempotent at the provider: the same key is the same charge. */
  idempotencyKey: string;
  description: string;
}

export interface PaymentResult {
  /** The provider's own id for the movement. Stored, never derived from. */
  reference: string;
  status: PaymentStatus;
}

export interface PaymentGateway {
  readonly kind: "mock" | "stripe";
  authorise(intent: PaymentIntent): Promise<PaymentResult>;
  capture(params: { reference: string; amountCents: number }): Promise<PaymentResult>;
  refund(params: { reference: string; amountCents: number; reason: string }): Promise<PaymentResult>;
  /** Pays a provider. Separate from refund: different direction, different rail. */
  payout(params: {
    providerId: string;
    jobId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<PaymentResult>;
}

/** The ledger entry each gateway call produces, and its sign. */
export const ENTRY_FOR: Record<
  "authorise" | "capture" | "refund" | "payout" | "void" | "payoutReversal",
  { kind: LedgerEntryKind; sign: 1 | -1 }
> = {
  authorise: { kind: "AUTHORISATION", sign: 1 },
  void: { kind: "AUTHORISATION_VOID", sign: -1 },
  capture: { kind: "CAPTURE", sign: 1 },
  refund: { kind: "REFUND", sign: -1 },
  payout: { kind: "PAYOUT", sign: -1 },
  payoutReversal: { kind: "PAYOUT_REVERSAL", sign: 1 }
};

/**
 * What the ledger adds up to.
 *
 * A fold, never a column. `authorised` is what is reserved but not yet taken;
 * `captured` is what was actually taken; `paidOut` is what left for providers.
 * `net` is what RESCUE is holding, which is the only figure that should ever
 * be described as a balance.
 */
export interface LedgerSummary {
  authorisedCents: number;
  capturedCents: number;
  refundedCents: number;
  paidOutCents: number;
  netCents: number;
}

export function summariseLedger(entries: readonly StoredLedgerEntry[]): LedgerSummary {
  const total = (kinds: LedgerEntryKind[]) =>
    entries
      .filter((entry) => kinds.includes(entry.kind))
      .reduce((sum, entry) => sum + entry.amountCents, 0);

  return {
    // Authorisations net of voids: a released hold is not still reserved.
    authorisedCents: total(["AUTHORISATION", "AUTHORISATION_VOID"]),
    capturedCents: total(["CAPTURE"]),
    // Stored negative, reported positive: "refunded 50,00" reads better than
    // "refunded -50,00", and the direction is already in the kind.
    refundedCents: -total(["REFUND"]),
    paidOutCents: -total(["PAYOUT", "PAYOUT_REVERSAL"]),
    /**
     * What RESCUE is actually holding: everything that moved, summed with its
     * own sign. Authorisations are excluded because a hold is not money --
     * counting it would overstate the balance by the value of every job that
     * has been approved and not yet done.
     */
    netCents: total(["CAPTURE", "REFUND", "PAYOUT", "PAYOUT_REVERSAL"])
  };
}

/**
 * Development gateway.
 *
 * Signs a reference with the job and the operation so it is stable across
 * runs and unique across jobs, and refuses the things a real gateway would
 * refuse -- a zero or negative amount, a capture larger than its
 * authorisation -- so the calling code meets those failures here rather than
 * for the first time in production.
 */
export class MockPaymentGateway implements PaymentGateway {
  readonly kind = "mock" as const;
  private readonly authorisations = new Map<string, number>();

  constructor(private readonly signingKey: string) {}

  private reference(operation: string, key: string): string {
    const digest = createHmac("sha256", this.signingKey).update(`${operation}:${key}`).digest("hex");
    return `mock_${operation}_${digest.slice(0, 20)}`;
  }

  private assertAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new AppError(422, "VALIDATION_ERROR", "A payment amount must be a positive whole number of cents");
    }
  }

  async authorise(intent: PaymentIntent): Promise<PaymentResult> {
    this.assertAmount(intent.amountCents);
    const reference = this.reference("auth", intent.idempotencyKey);
    // Idempotent: the same key returns the same authorisation rather than
    // placing a second hold on the customer's card.
    if (!this.authorisations.has(reference)) {
      this.authorisations.set(reference, intent.amountCents);
    }
    return { reference, status: "AUTHORISED" };
  }

  async capture(params: { reference: string; amountCents: number }): Promise<PaymentResult> {
    this.assertAmount(params.amountCents);
    const authorised = this.authorisations.get(params.reference);
    if (authorised === undefined) {
      throw new AppError(409, "CONFLICT", "There is no authorisation with that reference");
    }
    if (params.amountCents > authorised) {
      throw new AppError(
        409,
        "CONFLICT",
        "A capture cannot exceed the amount that was authorised"
      );
    }
    return { reference: this.reference("capture", params.reference), status: "CAPTURED" };
  }

  async refund(params: {
    reference: string;
    amountCents: number;
    reason: string;
  }): Promise<PaymentResult> {
    this.assertAmount(params.amountCents);
    return { reference: this.reference("refund", `${params.reference}:${params.reason}`), status: "REFUNDED" };
  }

  async payout(params: {
    providerId: string;
    jobId: string;
    amountCents: number;
    idempotencyKey: string;
  }): Promise<PaymentResult> {
    this.assertAmount(params.amountCents);
    return { reference: this.reference("payout", params.idempotencyKey), status: "CAPTURED" };
  }
}
