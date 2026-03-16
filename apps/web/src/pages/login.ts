import type { APIRoute } from "astro";

/**
 * Redirect to Cloudflare Access login.
 *
 * CF Access exposes `/cdn-cgi/access/login` on any protected domain.
 * After authenticating, CF Access redirects the user back to the app.
 *
 * Usage:
 *   - Visit /login to authenticate
 *   - Visit /login?redirect_url=/events to authenticate and return to /events
 */
export const GET: APIRoute = ({ request }) => {
  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect_url") || url.origin + "/";

  const loginUrl = new URL("/cdn-cgi/access/login", url.origin);
  loginUrl.searchParams.set("redirect_url", redirectUrl);

  return new Response(null, {
    status: 302,
    headers: { Location: loginUrl.toString() },
  });
};
