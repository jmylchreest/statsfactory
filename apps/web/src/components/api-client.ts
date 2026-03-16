/**
 * Shared API client for dashboard components.
 *
 * Authentication is handled by Cloudflare Access at the infrastructure level.
 * In production, the browser automatically sends CF Access cookies with every
 * request. In dev mode, the CF Access middleware is bypassed.
 *
 * The dashboard stores the selected app ID in localStorage so users don't
 * have to re-select their app on every page load.
 */

const APP_ID_STORAGE_KEY = "sf_selected_app_id";

export function getSelectedAppId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(APP_ID_STORAGE_KEY);
}

export function setSelectedAppId(appId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(APP_ID_STORAGE_KEY, appId);
}

export function clearSelectedAppId(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(APP_ID_STORAGE_KEY);
}

type QueryParams = Record<string, string | string[] | undefined>;

/**
 * Redirect the browser to the Cloudflare Access login page.
 *
 * CF Access exposes `/cdn-cgi/access/login` on any protected domain.
 * After successful authentication, CF Access redirects back to the
 * original URL automatically.
 */
function redirectToLogin(): never {
  const loginUrl = new URL("/cdn-cgi/access/login", window.location.origin);
  // Preserve the current page so CF Access can redirect back after auth
  loginUrl.searchParams.set("redirect_url", window.location.href);
  window.location.href = loginUrl.toString();
  // Throw to abort any calling code — the page is navigating away
  throw new Error("Redirecting to login...");
}

/**
 * Check a fetch response for authentication errors and redirect to
 * Cloudflare Access login if the user's session has expired or is missing.
 */
function handleAuthError(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    redirectToLogin();
  }
}

/**
 * Make a GET request to the query API.
 * No Bearer token needed — Cloudflare Access handles auth at the edge.
 */
export async function queryApi<T>(path: string, params?: QueryParams): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          url.searchParams.append(key, v);
        }
      } else {
        url.searchParams.set(key, value);
      }
    }
  }

  const res = await fetch(url.toString(), {
    credentials: "same-origin", // send CF Access cookies
  });

  handleAuthError(res);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Make a mutating request (POST, PATCH, DELETE) to the API.
 * No Bearer token needed — Cloudflare Access handles auth at the edge.
 */
export async function mutateApi<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, window.location.origin);

  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);

  handleAuthError(res);

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

/** Fetch the list of apps from the management API. */
export async function fetchApps(): Promise<
  Array<{ id: string; name: string; geoPrecision: string; retentionDays: number; createdAt: string }>
> {
  const res = await queryApi<{
    apps: Array<{ id: string; name: string; geoPrecision: string; retentionDays: number; createdAt: string }>;
  }>("/v1/apps");
  return res.apps;
}
