import { z } from "zod";
import {
  approveTriageSchema,
  cancelJobSchema,
  createJobSchema,
  createOffersSchema,
  createProviderDocumentSchema,
  createProviderSchema,
  createQuoteSchema,
  createVehicleSchema,
  decideQuoteSchema,
  devTokenRequestSchema,
  errorSchema,
  evidenceUploadTicketSchema,
  fallbackSchema,
  jobSchema,
  quoteSchema,
  assignmentOfferSchema,
  eligibilityResultSchema,
  providerSchema,
  requestEvidenceUploadSchema,
  respondToOfferSchema,
  reviewDocumentSchema,
  reviewProviderSchema,
  setAvailabilitySchema,
  triageSuggestionSchema,
  vehicleSchema,
  whoAmISchema
} from "@rescue/contracts";

/**
 * OpenAPI 3.1 generated from the same Zod schemas the routes validate with.
 *
 * Hand-written API docs drift from the code within a sprint. These cannot: if
 * a contract changes, the document changes with it, because there is only one
 * definition of each shape.
 */

const SCHEMAS = {
  Error: errorSchema,
  Job: jobSchema,
  CreateJob: createJobSchema,
  TriageSuggestion: triageSuggestionSchema,
  ApproveTriage: approveTriageSchema,
  CancelJob: cancelJobSchema,
  Provider: providerSchema,
  CreateProvider: createProviderSchema,
  ReviewProvider: reviewProviderSchema,
  SetAvailability: setAvailabilitySchema,
  Vehicle: vehicleSchema,
  CreateVehicle: createVehicleSchema,
  CreateProviderDocument: createProviderDocumentSchema,
  ReviewDocument: reviewDocumentSchema,
  EligibilityResult: eligibilityResultSchema,
  Quote: quoteSchema,
  CreateQuote: createQuoteSchema,
  DecideQuote: decideQuoteSchema,
  AssignmentOffer: assignmentOfferSchema,
  CreateOffers: createOffersSchema,
  RespondToOffer: respondToOfferSchema,
  Fallback: fallbackSchema,
  RequestEvidenceUpload: requestEvidenceUploadSchema,
  EvidenceUploadTicket: evidenceUploadTicketSchema,
  DevTokenRequest: devTokenRequestSchema,
  WhoAmI: whoAmISchema
} as const;

type SchemaName = keyof typeof SCHEMAS;

const ref = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });

function jsonBody(name: SchemaName) {
  return { required: true, content: { "application/json": { schema: ref(name) } } };
}

function jsonResponse(description: string, name?: SchemaName, wrapper: "data" | "list" | "raw" = "data") {
  if (!name) return { description };
  const schema =
    wrapper === "raw"
      ? ref(name)
      : wrapper === "list"
        ? { type: "object", properties: { data: { type: "array", items: ref(name) } } }
        : { type: "object", properties: { data: ref(name) } };
  return { description, content: { "application/json": { schema } } };
}

const ERRORS = {
  "400": jsonResponse("Validation or context error", "Error", "raw"),
  "401": jsonResponse("Missing or invalid credentials", "Error", "raw"),
  "403": jsonResponse("Authenticated but not permitted", "Error", "raw"),
  "404": jsonResponse("Not found, or not visible to this tenant", "Error", "raw"),
  "409": jsonResponse("Conflicting state", "Error", "raw"),
  "429": jsonResponse("Rate limited", "Error", "raw")
};

const IDEMPOTENCY_HEADER_PARAM = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", maxLength: 200 },
  description: "Unique per logical operation. Replaying the same key returns the stored response."
};

const TENANT_HEADER_PARAMS = [
  {
    name: "X-Organization-Id",
    in: "header",
    required: false,
    schema: { type: "string", format: "uuid" },
    description:
      "Selects among organisations the caller already belongs to. It cannot grant access to one they do not."
  },
  {
    name: "X-Provider-Id",
    in: "header",
    required: false,
    schema: { type: "string", format: "uuid" },
    description: "Selects among providers the caller already belongs to."
  }
];

const idParam = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" }
});

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    schemas[name] = z.toJSONSchema(schema as z.ZodType, {
      target: "openapi-3.0",
      io: "output",
      unrepresentable: "any"
    });
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "RESCUE Circular Logistics API",
      version,
      description:
        "B2B exception logistics for failed bulky deliveries, bulky returns and reusable company surplus.\n\n" +
        "Tenancy is derived from the authenticated principal's memberships. No endpoint accepts an " +
        "organisation identifier in a request body or query string.\n\n" +
        "All monetary values are integer euro cents."
    },
    servers: [{ url: "/v1" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" }
      },
      schemas
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          tags: ["ops"],
          summary: "Liveness. Touches no dependencies.",
          security: [],
          responses: { "200": jsonResponse("Service is alive") }
        }
      },
      "/ready": {
        get: {
          tags: ["ops"],
          summary: "Readiness. Checks dependencies.",
          security: [],
          responses: { "200": jsonResponse("Ready"), "503": jsonResponse("Not ready") }
        }
      },
      "/auth/dev-token": {
        post: {
          tags: ["auth"],
          summary: "Issue a development token. Absent in production.",
          security: [],
          requestBody: jsonBody("DevTokenRequest"),
          responses: { "201": jsonResponse("Token issued"), ...ERRORS }
        }
      },
      "/auth/me": {
        get: {
          tags: ["auth"],
          summary: "The caller's identity and active tenant",
          parameters: TENANT_HEADER_PARAMS,
          responses: { "200": jsonResponse("Current principal", "WhoAmI"), ...ERRORS }
        }
      },
      "/jobs": {
        post: {
          tags: ["jobs"],
          summary: "Create a recovery job in the caller's organisation",
          parameters: [IDEMPOTENCY_HEADER_PARAM, ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("CreateJob"),
          responses: { "201": jsonResponse("Job created with an advisory triage suggestion"), ...ERRORS }
        },
        get: {
          tags: ["jobs"],
          summary: "List jobs visible to the caller",
          parameters: [
            ...TENANT_HEADER_PARAMS,
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } }
          ],
          responses: { "200": jsonResponse("Page of jobs", "Job", "list"), ...ERRORS }
        }
      },
      "/jobs/{id}": {
        get: {
          tags: ["jobs"],
          summary: "Fetch one job",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("The job", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/events": {
        get: {
          tags: ["jobs"],
          summary: "Immutable event timeline for a job",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Events"), ...ERRORS }
        }
      },
      "/jobs/{id}/triage": {
        post: {
          tags: ["jobs"],
          summary: "Dispatcher approves the assessment (DRAFT to TRIAGED)",
          parameters: [idParam()],
          requestBody: jsonBody("ApproveTriage"),
          responses: { "200": jsonResponse("Job triaged", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/quotes": {
        post: {
          tags: ["quotes"],
          summary: "Price a triaged job. VAT is computed server-side.",
          parameters: [IDEMPOTENCY_HEADER_PARAM, idParam()],
          requestBody: jsonBody("CreateQuote"),
          responses: { "201": jsonResponse("Quote created"), ...ERRORS }
        },
        get: {
          tags: ["quotes"],
          summary: "Quotes for a job",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Quotes", "Quote", "list"), ...ERRORS }
        }
      },
      "/quotes/{quoteId}/decision": {
        post: {
          tags: ["quotes"],
          summary: "Customer approves or rejects a quote",
          parameters: [IDEMPOTENCY_HEADER_PARAM, idParam("quoteId"), ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("DecideQuote"),
          responses: { "200": jsonResponse("Decision recorded"), ...ERRORS }
        }
      },
      "/jobs/{id}/eligible-providers": {
        get: {
          tags: ["dispatch"],
          summary: "Ranked eligible providers, with reasons for every exclusion",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Eligibility results", "EligibilityResult", "list"), ...ERRORS }
        }
      },
      "/jobs/{id}/offers": {
        post: {
          tags: ["dispatch"],
          summary: "Offer the job to eligible providers",
          parameters: [IDEMPOTENCY_HEADER_PARAM, idParam()],
          requestBody: jsonBody("CreateOffers"),
          responses: { "201": jsonResponse("Offers created", "AssignmentOffer", "list"), ...ERRORS }
        },
        get: {
          tags: ["dispatch"],
          summary: "All offers for a job",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Offers", "AssignmentOffer", "list"), ...ERRORS }
        }
      },
      "/offers": {
        get: {
          tags: ["provider"],
          summary: "The calling provider's own offers",
          parameters: TENANT_HEADER_PARAMS,
          responses: { "200": jsonResponse("Offers", "AssignmentOffer", "list"), ...ERRORS }
        }
      },
      "/offers/{offerId}/response": {
        post: {
          tags: ["provider"],
          summary: "Accept or decline an offer",
          parameters: [idParam("offerId"), ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("RespondToOffer"),
          responses: { "200": jsonResponse("Response recorded"), ...ERRORS }
        }
      },
      "/offers/expire": {
        post: {
          tags: ["ops"],
          summary: "Run the dispatch sweep: expire lapsed offers, re-cover uncovered jobs",
          responses: { "200": jsonResponse("Sweep result"), ...ERRORS }
        }
      },
      "/jobs/{id}/fallback": {
        post: {
          tags: ["dispatch"],
          summary: "Release the assignment and return the job to TRIAGED",
          parameters: [idParam()],
          requestBody: jsonBody("Fallback"),
          responses: { "200": jsonResponse("Job returned to triage", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/start": {
        post: {
          tags: ["provider"],
          summary: "Mark work started (ASSIGNED to IN_PROGRESS)",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Job started", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/complete": {
        post: {
          tags: ["provider"],
          summary: "Complete the job. Requires at least one uploaded evidence item.",
          parameters: [idParam()],
          responses: { "200": jsonResponse("Job completed", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/cancel": {
        post: {
          tags: ["jobs"],
          summary: "Cancel a job",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("CancelJob"),
          responses: { "200": jsonResponse("Job cancelled", "Job"), ...ERRORS }
        }
      },
      "/jobs/{id}/evidence": {
        post: {
          tags: ["evidence"],
          summary: "Request a short-lived signed upload slot",
          parameters: [idParam()],
          requestBody: jsonBody("RequestEvidenceUpload"),
          responses: {
            "201": jsonResponse("Upload ticket", "EvidenceUploadTicket"),
            "413": jsonResponse("File too large", "Error", "raw"),
            "415": jsonResponse("Media type not allowed", "Error", "raw"),
            ...ERRORS
          }
        },
        get: {
          tags: ["evidence"],
          summary: "Evidence attached to a job",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Evidence"), ...ERRORS }
        }
      },
      "/evidence/{evidenceId}/complete": {
        post: {
          tags: ["evidence"],
          summary: "Confirm the upload finished",
          parameters: [idParam("evidenceId")],
          responses: { "200": jsonResponse("Evidence recorded"), ...ERRORS }
        }
      },
      "/evidence/{evidenceId}/download": {
        get: {
          tags: ["evidence"],
          summary: "Short-lived signed URL for one uploaded evidence object",
          parameters: [idParam("evidenceId"), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Download ticket"), ...ERRORS }
        }
      },
      "/jobs/{id}/ledger": {
        get: {
          tags: ["commerce"],
          summary: "Money movements on a job, with the fold over them",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Ledger entries and totals"), ...ERRORS }
        }
      },
      "/providers": {
        post: {
          tags: ["providers"],
          summary: "Register a provider. Starts PENDING and is not dispatchable.",
          requestBody: jsonBody("CreateProvider"),
          responses: { "201": jsonResponse("Provider created", "Provider"), ...ERRORS }
        },
        get: {
          tags: ["providers"],
          summary: "List providers (staff only)",
          responses: { "200": jsonResponse("Providers", "Provider", "list"), ...ERRORS }
        }
      },
      "/providers/{id}": {
        get: {
          tags: ["providers"],
          summary: "Fetch a provider",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Provider", "Provider"), ...ERRORS }
        }
      },
      "/providers/{id}/review": {
        post: {
          tags: ["providers"],
          summary: "Compliance activates, suspends or rejects a provider",
          parameters: [idParam()],
          requestBody: jsonBody("ReviewProvider"),
          responses: { "200": jsonResponse("Provider updated", "Provider"), ...ERRORS }
        }
      },
      "/providers/{id}/availability": {
        post: {
          tags: ["providers"],
          summary: "The provider pauses or resumes taking work. Distinct from /review.",
          parameters: [idParam()],
          requestBody: jsonBody("SetAvailability"),
          responses: { "200": jsonResponse("Provider updated", "Provider"), ...ERRORS }
        }
      },
      "/providers/{id}/vehicles": {
        post: {
          tags: ["providers"],
          summary: "Add a vehicle. The registration is hashed, never stored.",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("CreateVehicle"),
          responses: { "201": jsonResponse("Vehicle added", "Vehicle"), ...ERRORS }
        },
        get: {
          tags: ["providers"],
          summary: "List vehicles",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Vehicles", "Vehicle", "list"), ...ERRORS }
        }
      },
      "/providers/{id}/documents": {
        post: {
          tags: ["providers"],
          summary: "Submit a compliance document",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          requestBody: jsonBody("CreateProviderDocument"),
          responses: { "201": jsonResponse("Document submitted"), ...ERRORS }
        },
        get: {
          tags: ["providers"],
          summary: "List compliance documents",
          parameters: [idParam(), ...TENANT_HEADER_PARAMS],
          responses: { "200": jsonResponse("Documents"), ...ERRORS }
        }
      },
      "/providers/{id}/documents/{documentId}/review": {
        post: {
          tags: ["providers"],
          summary: "Compliance verifies or rejects a document",
          parameters: [idParam(), idParam("documentId")],
          requestBody: jsonBody("ReviewDocument"),
          responses: { "200": jsonResponse("Document reviewed"), ...ERRORS }
        }
      }
    }
  };
}
