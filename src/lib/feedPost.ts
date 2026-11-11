import type { EventPostRequest } from "./contracts.js";

/**
 * Minimal fire-and-forget calls from part A processes to the feed server.
 * The feed may not be running yet (parallel development) — failures are logged once, never thrown.
 */
let warned = false;

export async function postJson(feedUrl: string, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(new URL(path, feedUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[feed] POST ${path} → ${res.status} ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    if (!warned) {
      console.warn(`[feed] unreachable at ${feedUrl} (${(err as Error).message}); continuing without it.`);
      warned = true;
    }
    return false;
  }
}

export function emit(feedUrl: string, event: EventPostRequest): Promise<boolean> {
  return postJson(feedUrl, "/events", event);
}
