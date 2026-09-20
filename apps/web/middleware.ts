import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALES } from "./i18n/index";

/**
 * Locale routing. Every page lives under `/de` or `/en`; a bare path is sent
 * to the visitor's preferred locale, defaulting to German.
 */
/**
 * The demo gate.
 *
 * The demo runs the API with its development sign-in enabled, which is what
 * lets a visitor step into any of the three consoles without an account. That
 * is the point, and it is also why the site cannot simply be open: anyone who
 * found the URL would be a dispatcher. HTTP Basic is the right shape here --
 * the browser prompts natively, there is no sign-in page to build, and a
 * password in the environment is the whole mechanism.
 *
 * It protects nothing real. There is no live data behind it, the store is
 * in-memory and resets on restart, and it is a shared password, so it is a
 * gate rather than a security boundary. What it prevents is the demo being
 * indexed, linked and wandered into.
 *
 * Unset `DEMO_GATE_PASSWORD` and this disappears, which is the real
 * deployment's configuration.
 */
function demoGate(request: NextRequest): NextResponse | null {
  const password = process.env.DEMO_GATE_PASSWORD;
  if (!password) return null;

  const expected = `Basic ${btoa(`${process.env.DEMO_GATE_USER ?? "rescue"}:${password}`)}`;
  const provided = request.headers.get("authorization");

  // Length first, then a full comparison. Basic auth over TLS with a shared
  // demo password does not warrant a constant-time compare, and pretending
  // otherwise would suggest this is load-bearing.
  if (provided !== null && provided.length === expected.length && provided === expected) {
    return null;
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      // The realm is what the browser shows in its prompt.
      "www-authenticate": 'Basic realm="RESCUE demo", charset="UTF-8"',
      // A 401 that a cache stored would lock out the next visitor.
      "cache-control": "no-store"
    }
  });
}

export function middleware(request: NextRequest) {
  const gated = demoGate(request);
  if (gated) return gated;

  const { pathname } = request.nextUrl;

  const hasLocale = LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );
  if (hasLocale) return NextResponse.next();

  const preferred = request.headers.get("accept-language") ?? "";
  // Only switch away from German when the browser actually asks for English
  // ahead of German; anything else gets the pilot market's language.
  const wantsEnglish = /\ben\b/i.test(preferred.split(",")[0] ?? "");
  const locale = wantsEnglish ? "en" : DEFAULT_LOCALE;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === "/" ? "" : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals, the API proxy routes, static files and
  // the liveness probe -- which must answer the orchestrator without
  // credentials, or a gated demo restart-loops a container that is working.
  matcher: ["/((?!_next|api|healthz|favicon.ico|.*\\.[^/]+$).*)"]
};
