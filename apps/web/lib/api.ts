const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

/**
 * Minimal API client.
 *
 * The full role-aware session handling is Phase 3. What matters here is that
 * the client can no longer name its own tenant: the API derives the
 * organisation from the token, and there is no field to send.
 */
export async function apiRequest<T>(
  path: string,
  init: RequestInit & { token?: string; idempotencyKey?: string } = {}
): Promise<T> {
  const { token, idempotencyKey, ...rest } = init;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(rest.headers as Record<string, string> | undefined)
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const response = await fetch(`${API_URL}${path}`, { ...rest, headers });

  // A gateway error page is not JSON. Parsing it blindly produced an opaque
  // "Unexpected token" for the user (finding L4).
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const error: ApiError = new Error(
      response.ok ? "The server returned an unexpected response." : `Request failed (${response.status}).`
    );
    error.status = response.status;
    throw error;
  }

  const body = await response.json();
  if (!response.ok) {
    const error: ApiError = new Error(body?.error?.message ?? "Request failed");
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

/**
 * Development sign-in.
 *
 * Exchanges a seeded subject for a token via the API's development identity
 * provider. That endpoint does not exist in production, and this helper is
 * replaced by a real OIDC session in Phase 3. It exists so the request flow is
 * exercisable end to end today.
 */
export async function devSignIn(subject: string): Promise<string> {
  const response = await apiRequest<{ data: { accessToken: string } }>("/v1/auth/dev-token", {
    method: "POST",
    body: JSON.stringify({ subject })
  });
  return response.data.accessToken;
}

/** Idempotency keys are required on mutations. */
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
