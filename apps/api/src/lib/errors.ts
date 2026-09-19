import type { ErrorCode } from "@rescue/contracts";

/**
 * An error with a stable, documented code and an HTTP status. Anything thrown
 * that is not an AppError is treated as an internal fault and reported to the
 * client as a bare 500 with no detail.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = (message = "Authentication required") =>
  new AppError(401, "UNAUTHENTICATED", message);

export const forbidden = (message = "You do not have permission to perform this action") =>
  new AppError(403, "FORBIDDEN", message);

/**
 * Deliberately 404, not 403, for cross-tenant access.
 *
 * Finding C4: answering 403 for a record that exists in another tenant
 * confirms the record exists, which is itself a leak. A caller who is not
 * entitled to a record is told it does not exist.
 */
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);

export const conflict = (message: string) => new AppError(409, "CONFLICT", message);

export const organizationRequired = () =>
  new AppError(
    400,
    "ORGANIZATION_REQUIRED",
    "This account belongs to more than one organisation. Send X-Organization-Id to choose one."
  );

export const providerContextRequired = () =>
  new AppError(
    400,
    "PROVIDER_CONTEXT_REQUIRED",
    "This account belongs to more than one provider. Send X-Provider-Id to choose one."
  );

export const invalidTransition = (from: string, to: string) =>
  new AppError(409, "INVALID_STATE_TRANSITION", `A job cannot move from ${from} to ${to}`);

export const idempotencyKeyRequired = () =>
  new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "This request requires an Idempotency-Key header");

export const idempotencyKeyReused = () =>
  new AppError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "This Idempotency-Key was already used with a different request body"
  );
