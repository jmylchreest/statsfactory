import type { APIRoute } from "astro";

/**
 * Redirect to Cloudflare Access logout.
 *
 * CF Access exposes `/cdn-cgi/access/logout` on any protected domain.
 * This ends the user's CF Access session and clears the auth cookie.
 */
export const GET: APIRoute = ({ request }) => {
  const url = new URL(request.url);
  const logoutUrl = new URL("/cdn-cgi/access/logout", url.origin);

  return new Response(null, {
    status: 302,
    headers: { Location: logoutUrl.toString() },
  });
};
