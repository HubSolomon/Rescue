import { NextResponse } from "next/server";
import { api, ApiError } from "../../../../lib/api";
import { isLocale } from "../../../../i18n/index";

/**
 * Proof download.
 *
 * The page links here rather than to the storage URL directly, for two
 * reasons. The signed URL is short-lived, so one minted while the page
 * rendered would already be stale by the time anyone clicked it. And it would
 * have to be serialised into the page payload to be clickable, which puts a
 * credential-bearing URL into the HTML of every render, cached or shared.
 *
 * Instead the ticket is fetched at click time, on the server, with the
 * session cookie, and the browser is redirected to it. The URL exists for the
 * length of one redirect.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ locale: string; evidenceId: string }> }
) {
  const { locale, evidenceId } = await context.params;
  if (!isLocale(locale)) return new NextResponse(null, { status: 404 });

  try {
    const ticket = await api.get<{ downloadUrl: string }>(
      `/v1/evidence/${evidenceId}/download`
    );
    // 307, not 302: the method must be preserved and the response must never
    // be treated as the canonical location of the proof.
    return NextResponse.redirect(ticket.downloadUrl, {
      status: 307,
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return NextResponse.redirect(new URL(`/${locale}/sign-in`, _request.url), { status: 307 });
    }
    // Absent, or not ours. Both are "no proof here" from the browser's side.
    return new NextResponse(null, { status: 404 });
  }
}
