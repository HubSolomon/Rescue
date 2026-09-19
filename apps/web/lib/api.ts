import "server-only";
import { randomUUID } from "node:crypto";
import { readSessionToken } from "./session";

/**
 * Server-side API client.
 *
 * Every call runs on the server with the token from the httpOnly cookie, so
 * the browser never holds a credential. Idempotency keys are generated here
 * rather than in the browser, which means a double-submitted form replays the
 * stored response instead of creating a second job.
 */

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

/** Error codes the API documents. Mapped to localised copy in `i18n`. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Set for mutations. Generated automatically when omitted. */
  idempotencyKey?: string;
  /** GET responses are not cached by default: this data changes constantly. */
  revalidate?: number | false;
  /** Bypass the session cookie, for the sign-in exchange itself. */
  anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  // Only declare a JSON body when there is one. Declaring `application/json`
  // and then sending nothing is what a strict server (Fastify) rejects with
  // FST_ERR_CTP_EMPTY_JSON_BODY, and several of our actions -- start,
  // complete, evidence confirmation -- are deliberately bodyless.
  if (options.body !== undefined) headers["content-type"] = "application/json";

  if (!options.anonymous) {
    const token = await readSessionToken();
    if (!token) throw new ApiError("UNAUTHENTICATED", 401, "No session");
    headers.authorization = `Bearer ${token}`;
  }
  if (method === "POST") {
    headers["idempotency-key"] = options.idempotencyKey ?? randomUUID();
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      ...(options.revalidate !== undefined && options.revalidate !== false
        ? { next: { revalidate: options.revalidate } }
        : {})
    });
  } catch {
    // A connection failure is not an API error with a code; it needs its own
    // message so the user is told the API is down rather than "unknown error".
    throw new ApiError("NETWORK", 0, "The API is unreachable");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError("UNKNOWN", response.status, `Unexpected ${response.status} response`);
  }

  const payload = (await response.json()) as
    | { data: T; meta?: unknown }
    | { error: { code: string; message: string; details?: unknown } };

  if (!response.ok) {
    const error = "error" in payload ? payload.error : undefined;
    throw new ApiError(
      error?.code ?? "UNKNOWN",
      response.status,
      error?.message ?? "Request failed",
      error?.details
    );
  }
  return (payload as { data: T }).data;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    request<T>(path, { ...options, method: "POST", body })
};

/** Also returns `meta`, for paginated list endpoints. */
export async function getWithMeta<T>(
  path: string
): Promise<{ data: T; meta?: { nextCursor?: string | null } }> {
  const token = await readSessionToken();
  if (!token) throw new ApiError("UNAUTHENTICATED", 401, "No session");
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store"
    });
  } catch {
    throw new ApiError("NETWORK", 0, "The API is unreachable");
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? "UNKNOWN",
      response.status,
      payload?.error?.message ?? "Request failed"
    );
  }
  return payload;
}

/** Exchanges a seeded subject for a token. Development identity provider only. */
export async function exchangeDevToken(subject: string): Promise<string> {
  const result = await request<{ accessToken: string }>("/v1/auth/dev-token", {
    method: "POST",
    body: { subject },
    anonymous: true
  });
  return result.accessToken;
}

export { API_URL };
