/**
 * Liveness for the web container.
 *
 * Separate from the locale-routed pages for one reason: the demo gate. The
 * container's own HEALTHCHECK and the host's health check both call this
 * without credentials, and a gate that returns 401 to them reads as a dead
 * process -- the orchestrator restarts a container that is working, forever.
 *
 * It answers whether this process is serving, and deliberately nothing else.
 * It does not call the API: a web container that is up and an API that is
 * down are different failures, and a health check that conflates them turns
 * an API outage into a restart loop of a healthy web server.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
