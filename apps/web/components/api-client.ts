import {
  ORGANIZATION_ASSERTION_HEADER,
  organizationAssertionSchema,
} from "@relay/contracts";

/** Minimal client-side envelope shared by every in-app fetch. */
export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string } };

/**
 * Perform a fetch and parse a JSON object body. Returns null for network
 * failures, non-JSON content types (HTML error pages, proxies) and non-object
 * bodies so callers can fall back to one uniform "unavailable" outcome.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ response: Response; data: Record<string, unknown> } | null> {
  try {
    const response = await fetch(url, init);
    const mediaType = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return { response, data: data as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Organization of the workspace this tab is currently rendering. The workspace
 * shell sets it once when a snapshot loads (and clears it otherwise); product
 * POSTs assert it so a switch made in another tab is rejected, not applied.
 * It is an assertion only; the server resolves the real tenant.
 */
let renderedOrganizationId: string | null = null;
export function setRenderedOrganization(organizationId: string | null) {
  renderedOrganizationId =
    organizationId !== null &&
    organizationAssertionSchema.safeParse(organizationId).success
      ? organizationId
      : null;
}

/** Code for the server's "workspace changed in another tab" CONFLICT. */
export const WORKSPACE_CHANGED = "WORKSPACE_CHANGED";
export const WORKSPACE_CHANGED_MESSAGE =
  "The workspace changed in another tab. Refresh to continue.";
const workspaceChangedListeners = new Set<() => void>();
export function onWorkspaceChanged(listener: () => void) {
  workspaceChangedListeners.add(listener);
  return () => {
    workspaceChangedListeners.delete(listener);
  };
}

const unavailable = (): ApiResult<never> => ({
  ok: false,
  error: { code: "DEPENDENCY_UNAVAILABLE" },
});

/**
 * JSON GET/POST (or multipart POST when `body` is FormData) against an
 * application endpoint, resolving to the `{ ok }` envelope. Anything else,
 * including non-JSON bodies and 5xx pages, becomes DEPENDENCY_UNAVAILABLE.
 */
export async function request<T>(
  path: string,
  body?: object | FormData,
): Promise<ApiResult<T>> {
  const form = body instanceof FormData;
  const hasBody = body !== undefined;
  const result = await fetchJson(path, {
    method: hasBody ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(hasBody &&
      renderedOrganizationId !== null &&
      path.startsWith("/api/product/")
        ? { [ORGANIZATION_ASSERTION_HEADER]: renderedOrganizationId }
        : {}),
      ...(hasBody && !form ? { "Content-Type": "application/json" } : {}),
    },
    ...(hasBody ? { body: form ? body : JSON.stringify(body) } : {}),
  });
  if (!result) return unavailable();
  const { data } = result;
  if (data.ok === true && "value" in data)
    return { ok: true, value: data.value as T };
  if (data.ok === true) return { ok: true, value: undefined as T };
  if (data.ok === false) {
    const error = data.error;
    let code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "DEPENDENCY_UNAVAILABLE";
    // Same CONFLICT code as a stale record; only the neutral message differs.
    if (
      code === "CONFLICT" &&
      hasBody &&
      error &&
      typeof error === "object" &&
      (error as { message?: unknown }).message === WORKSPACE_CHANGED_MESSAGE
    ) {
      code = WORKSPACE_CHANGED;
      for (const listener of workspaceChangedListeners) listener();
    }
    return { ok: false, error: { code } };
  }
  return unavailable();
}

/** The single status-code to user-copy map for product screens. */
export function errorMessage(code: string): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Please sign in to access your workspace.";
    case "FORBIDDEN":
      return "You do not have permission to access this workspace.";
    case WORKSPACE_CHANGED:
      return WORKSPACE_CHANGED_MESSAGE;
    case "CONFLICT":
      return "This record changed. Refresh the workspace and try again.";
    case "VALIDATION":
      return "Please check the fields and try again.";
    default:
      return "The service is unavailable. Please try again.";
  }
}
