import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { unauthenticated } from "../errors.js";

/**
 * Authentication is an abstraction with two implementations: a real OIDC
 * verifier backed by the provider's JWKS, and a local HS256 issuer used only
 * outside production. Route code never sees either -- it sees a Principal.
 *
 * Nothing in this file decides *what* a caller may do. It establishes only
 * *who* they are. Authorisation reads memberships from the database.
 */

export const DEV_ISSUER = "rescue-dev";
export const API_AUDIENCE = "rescue-api";

export interface VerifiedToken {
  subject: string;
  email?: string;
  name?: string;
}

export interface TokenVerifier {
  readonly kind: "oidc" | "dev";
  verify(token: string): Promise<VerifiedToken>;
}

function claimsToToken(payload: JWTPayload): VerifiedToken {
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    throw unauthenticated("Token has no subject claim");
  }
  return {
    subject,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined
  };
}

/**
 * Verifies tokens against a real identity provider's published keys.
 * Signature, issuer, audience and expiry are all checked by `jwtVerify`; a
 * failure of any of them surfaces as 401 with no detail about which.
 */
export class OidcTokenVerifier implements TokenVerifier {
  readonly kind = "oidc" as const;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    jwksUri: string,
    private readonly audience: string = API_AUDIENCE
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }

  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 5
      });
      return claimsToToken(payload);
    } catch {
      throw unauthenticated("Invalid or expired token");
    }
  }
}

/**
 * Symmetric verifier for development and tests. Never constructed when
 * NODE_ENV is production -- `buildAuth` refuses to fall back to it there.
 */
export class DevTokenVerifier implements TokenVerifier {
  readonly kind = "dev" as const;
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: DEV_ISSUER,
        audience: API_AUDIENCE,
        clockTolerance: 5
      });
      return claimsToToken(payload);
    } catch {
      throw unauthenticated("Invalid or expired token");
    }
  }
}

export class DevTokenIssuer {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(
    subject: string,
    expiresInSeconds: number,
    claims: { email?: string; name?: string } = {}
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiry = issuedAt + expiresInSeconds;
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(subject)
      .setIssuer(DEV_ISSUER)
      .setAudience(API_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiry)
      .sign(this.key);
    return { token, expiresAt: new Date(expiry * 1000) };
  }
}

/** Extracts a bearer token, or throws 401. Never logs the token itself. */
export function bearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) throw unauthenticated();
  const [scheme, value] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) {
    throw unauthenticated("Expected an Authorization: Bearer <token> header");
  }
  return value.trim();
}
