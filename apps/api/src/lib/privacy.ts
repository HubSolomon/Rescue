/**
 * The data inventory, as code.
 *
 * A GDPR record of processing activities is normally a spreadsheet, and a
 * spreadsheet drifts from the schema within a month of being written. This is
 * the same content in a form that a test can hold against
 * `schema.prisma`: adding a table without classifying it fails the build, and
 * so does classifying a table that no longer exists.
 *
 * It is not legal advice and it is not a completed ROPA. It is the engineering
 * half -- what is stored, where, and what happens to it -- laid out so that the
 * controller filling in the legal half has something accurate to work from.
 * The retention periods here are defensible defaults, not determinations; see
 * docs/audits/DATA_INVENTORY.md for the reasoning behind each, and expect a
 * controller to change some of them.
 */

/** Why the data may be held at all. Article 6(1) references in the docs. */
export type LawfulBasis =
  /** 6(1)(b): needed to perform the contract with the customer or provider. */
  | "contract"
  /** 6(1)(c): a statutory obligation, principally German tax and trade law. */
  | "legal-obligation"
  /** 6(1)(f): a legitimate interest, balanced and documented. */
  | "legitimate-interest";

/**
 * What happens when a person exercises the right to erasure.
 *
 * The distinction that matters: a record RESCUE must keep for ten years under
 * §147 AO cannot be deleted because someone asks, but the *name* attached to
 * it usually can be. So most rows are not deleted -- they are severed from the
 * person, which is what the law actually contemplates.
 */
export type ErasureStrategy =
  /** The row goes. */
  | "delete"
  /** Identifying fields are overwritten; the row and its structure remain. */
  | "redact"
  /**
   * Nothing changes here. The row holds no identifier of its own, and becomes
   * anonymous once the record it points at has been redacted.
   */
  | "pseudonymous-already"
  /**
   * Retained against the person's wishes, with a reason. Article 17(3)(b):
   * erasure does not apply where processing is required by law.
   */
  | "retain-by-law";

export interface TableClassification {
  /** The Prisma model name, exactly. */
  table: string;
  /** Fields that identify or describe a natural person. Empty is a claim. */
  personalFields: string[];
  basis: LawfulBasis;
  /**
   * Days, or null where retention is bounded by the record's own lifecycle
   * rather than by a clock.
   */
  retentionDays: number | null;
  erasure: ErasureStrategy;
  /** Why. Read by a human, in an audit, under time pressure. */
  note: string;
}

/** Ten years. §147 AO, for anything that feeds a tax return. */
const TAX_YEARS = 10 * 365;
/** Six years. §257 HGB, for commercial correspondence. */
const COMMERCIAL_YEARS = 6 * 365;

export const DATA_INVENTORY: TableClassification[] = [
  {
    table: "User",
    personalFields: ["subject", "email", "name"],
    basis: "contract",
    retentionDays: null,
    erasure: "redact",
    note:
      "The only table holding a name. Erasure overwrites all three fields, which breaks the link from every actorId in the system to a person in one operation -- the reason nothing else stores a name."
  },
  {
    table: "Membership",
    personalFields: [],
    basis: "contract",
    retentionDays: null,
    erasure: "pseudonymous-already",
    note: "A user id, a tenant id and a role. Meaningless once the User row is redacted."
  },
  {
    table: "Organization",
    personalFields: [],
    basis: "contract",
    retentionDays: TAX_YEARS,
    erasure: "retain-by-law",
    note:
      "A company, not a person. A sole trader's company name can be personal data, which is why the basis is contract and not legitimate interest -- but it is also an invoice counterparty, so it is kept."
  },
  {
    table: "Provider",
    personalFields: ["legalName", "contactEmail"],
    basis: "contract",
    retentionDays: TAX_YEARS,
    erasure: "retain-by-law",
    note:
      "Frequently a sole trader, so legalName and contactEmail are personal data. Both are invoice details: retained for the tax period, then redacted with the same routine as User."
  },
  {
    table: "Vehicle",
    personalFields: ["registrationHash"],
    basis: "contract",
    retentionDays: null,
    erasure: "pseudonymous-already",
    note:
      "A German registration identifies a keeper, so it is never stored raw -- only a keyed hash, which cannot be reversed without the key and is not stored beside it."
  },
  {
    table: "ProviderDocument",
    personalFields: ["storageKey"],
    basis: "legal-obligation",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "retain-by-law",
    note:
      "Insurance certificates and waste-carrier permits name the holder. They are the evidence that a vetted provider was vetted; deleting one on request would remove the proof that the check happened."
  },
  {
    table: "Job",
    personalFields: ["pickup", "destination", "notes", "customerReference"],
    basis: "contract",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "redact",
    note:
      "A pickup and a destination are someone's home or workplace, and notes carry gate codes and floor numbers. The addresses belong to the ordering organisation, so an individual's erasure request does not reach them -- the organisation's does."
  },
  {
    table: "Quote",
    personalFields: [],
    basis: "legal-obligation",
    retentionDays: TAX_YEARS,
    erasure: "retain-by-law",
    note: "Prices and a job id. An approved quote is a contract document."
  },
  {
    table: "AssignmentOffer",
    personalFields: [],
    basis: "contract",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "pseudonymous-already",
    note: "Ids, money and a decline reason. No personal data of its own."
  },
  {
    table: "Assignment",
    personalFields: [],
    basis: "legal-obligation",
    retentionDays: TAX_YEARS,
    erasure: "retain-by-law",
    note: "What a provider was paid for. A payout record."
  },
  {
    table: "Evidence",
    personalFields: ["storageKey", "uploadedByUserId"],
    basis: "contract",
    retentionDays: 365,
    erasure: "delete",
    note:
      "The largest concentration of personal data in the system: photographs of doorways, hallways and occasionally people, plus signatures. One year, because its purpose -- proving the job was done -- expires with the window for disputing it. The object is deleted from storage, not only the row."
  },
  {
    table: "IdempotencyKey",
    personalFields: ["responseBody"],
    basis: "legitimate-interest",
    retentionDays: 7,
    erasure: "delete",
    note:
      "A stored response body is a copy of whatever the endpoint returned, which for a job read is an address. Short-lived by design: it exists to make a retry safe, and a retry does not arrive a week later."
  },
  {
    table: "JobEvent",
    personalFields: [],
    basis: "legal-obligation",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "retain-by-law",
    note:
      "Ids, statuses and amounts, never an address or a name -- an invariant with a test, because an audit log that has to be redacted is not an audit log. `actorId` points at User, so redaction there anonymises the whole stream at once."
  },
  {
    table: "AuditLog",
    personalFields: [],
    basis: "legal-obligation",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "retain-by-law",
    note: "As JobEvent. Append-only in the database, not only in the code."
  },
  {
    table: "OutboxMessage",
    personalFields: ["payload"],
    basis: "contract",
    retentionDays: 30,
    erasure: "delete",
    note:
      "A payload can carry a recipient. Delivered rows are removed after thirty days, which is long enough to investigate a complaint about a message and short enough that the queue is not an archive. Dead letters are exempt: they are undelivered work and must survive until someone has dealt with them."
  },
  {
    table: "LedgerEntry",
    personalFields: [],
    basis: "legal-obligation",
    retentionDays: TAX_YEARS,
    erasure: "retain-by-law",
    note:
      "A job id, a kind and an integer. Deliberately holds nothing else, which is what makes ten-year retention unproblematic."
  },
  {
    table: "Suggestion",
    personalFields: ["output"],
    basis: "legitimate-interest",
    retentionDays: COMMERCIAL_YEARS,
    erasure: "retain-by-law",
    note:
      "A vehicle class, a worker count and a confidence. Kept because Article 22 and the AI Act both turn on being able to say what was proposed and by which prompt version -- the record that makes the human-in-the-loop claim checkable."
  }
];

export function classificationFor(table: string): TableClassification | undefined {
  return DATA_INVENTORY.find((entry) => entry.table === table);
}

/** Tables the retention job may remove rows from, with their windows. */
export const DELETABLE: ReadonlyArray<{ table: string; retentionDays: number }> = DATA_INVENTORY.filter(
  (entry): entry is TableClassification & { retentionDays: number } =>
    entry.erasure === "delete" && entry.retentionDays !== null
).map((entry) => ({ table: entry.table, retentionDays: entry.retentionDays }));

/** What a redaction writes over a name. Recognisable in a support call. */
export const REDACTED_NAME = "Gelöschte Person";
/**
 * `.invalid` is reserved by RFC 2606 and can never be delivered to, so a
 * redacted address cannot accidentally become a live recipient.
 */
export function redactedEmail(userId: string): string {
  return `erased-${userId}@erased.invalid`;
}
/**
 * The subject claim is severed too, and with a value no identity provider can
 * issue. Without this, the same person signing in again would be matched to
 * the record they asked to have erased.
 */
export function redactedSubject(userId: string): string {
  return `erased:${userId}`;
}
