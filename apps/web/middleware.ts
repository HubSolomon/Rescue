import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, LOCALES } from "./i18n/index";

/**
 * Locale routing. Every page lives under `/de` or `/en`; a bare path is sent
 * to the visitor's preferred locale, defaulting to German.
 */
export function middleware(request: NextRequest) {
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
  // Everything except Next internals, the API proxy routes and static files.
  matcher: ["/((?!_next|api|favicon.ico|.*\\.[^/]+$).*)"]
};
