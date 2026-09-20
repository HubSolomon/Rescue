/**
 * What never reaches a log line.
 *
 * Logs are the least access-controlled store in most deployments: they are
 * shipped to a third party, kept longer than the database, and readable by
 * people who would never be granted a row in `Job`. Under the GDPR that makes
 * an unredacted log a second copy of personal data with a different retention
 * period and a different set of readers -- which is a finding on its own, quite
 * apart from anything leaking.
 *
 * Two rules follow, and both are enforced here rather than left to whoever
 * writes the next `log.info`:
 *
 * 1. Credentials never appear at all, in any form, at any level.
 * 2. Personal data is redacted from the automatic request and response logs.
 *    Deliberate logging of an address for an operational reason still has to
 *    pass through a call that names it, which is a thing a reviewer can see.
 *
 * Pino's `redact` takes literal paths, so this list is exhaustive by
 * construction and there is a test that walks a request through the logger and
 * asserts each one is gone.
 */

/** Wildcard segments pino accepts: `*` for one level, `[*]` for array items. */
export const REDACTED_LOG_PATHS: string[] = [
  /* -------------------------------------------------------- credentials */
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "apiKey",

  /* ------------------------------------------------------ personal data */
  // A pickup and a dropoff are someone's home or workplace, and a job's
  // contact block is a name and a phone number. All four appear in request
  // bodies, which is exactly what an error log tends to include.
  "body.pickup",
  "body.dropoff",
  "body.contact",
  "body.customerNote",
  "job.pickup",
  "job.dropoff",
  "job.contact",
  "pickup.line1",
  "dropoff.line1",
  "contact.phone",
  "contact.email",
  "contact.name",
  "recipient",
  "email",
  "phone",

  /* --------------------------------------------------- notification bodies */
  // The subject says what happened; the body can contain an address. The
  // sender logs the subject at info and the body at debug for that reason,
  // and this makes the distinction hold even if someone changes the level.
  "notification.body",
  "notification.to",

  /* ---------------------------------------------------------- identifiers */
  // A vehicle registration is personal data about a driver in Germany. It is
  // hashed before storage; this stops the raw value surviving in a log of the
  // request that carried it.
  "body.registration",
  "vehicle.registration",
  "registration"
];

/** The string pino substitutes. Distinctive enough to grep a log archive for. */
export const REDACTION_MARKER = "[redacted]";
