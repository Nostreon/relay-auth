import { createClient, SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

let supabase: SupabaseClient;

function getSupabase(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    );
  }
  return supabase;
}

const GATED_RELAY_URL =
  process.env.GATED_RELAY_URL || "ws://strfry-gated:7777";

/**
 * Query the gated relay for valid NIP-63 membership events (kind 1163)
 * where the subscriber is tagged and the NIP-40 expiration hasn't passed.
 *
 * This is the protocol-native path: a payment provider publishes a kind 1163
 * event with `["p", <subscriber>]` and `["expiration", <unix-ts>]` (NIP-40)
 * once payment is confirmed. Any relay or service can read these events to
 * decide who has access — no shared database required.
 *
 * See: https://github.com/nostr-protocol/nips/pull/2156 (NIP-63)
 */
async function hasNip63Membership(pubkey: string): Promise<{
  allowed: boolean;
  expires_at?: number;
}> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ allowed: false });
    }, 3000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(GATED_RELAY_URL);
    } catch {
      clearTimeout(timeout);
      resolve({ allowed: false });
      return;
    }

    const subId = Math.random().toString(36).slice(2, 10);
    const now = Math.floor(Date.now() / 1000);
    let found = false;

    ws.on("open", () => {
      ws.send(
        JSON.stringify([
          "REQ",
          subId,
          { kinds: [1163], "#p": [pubkey], limit: 10 },
        ])
      );
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg[0] === "EVENT" && msg[1] === subId) {
          const event = msg[2];
          // NIP-40 expiration tag
          const expirationTag = event.tags?.find(
            (t: string[]) => t[0] === "expiration"
          );

          if (expirationTag) {
            const expiresAt = parseInt(expirationTag[1]);
            if (expiresAt > now) {
              found = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ allowed: true, expires_at: expiresAt });
            }
            // expired membership, keep scanning
          } else {
            // No expiration tag = perpetual access
            found = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ allowed: true });
          }
        }

        if (msg[0] === "EOSE" && msg[1] === subId) {
          clearTimeout(timeout);
          ws.close();
          if (!found) {
            resolve({ allowed: false });
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", () => {
      clearTimeout(timeout);
      resolve({ allowed: false });
    });
  });
}

/**
 * Check if a pubkey has access via either:
 *   1. An active subscription row in the database (platform-native path)
 *   2. A valid NIP-63 kind 1163 membership event on the gated relay
 *      (protocol-native path)
 *
 * Both are checked in parallel. The database path takes priority because it
 * carries richer metadata (which tier, which creator). The NIP-63 path is the
 * fallback that lets relays grant access even when no DB integration exists,
 * which is what makes this service usable for any payment provider that
 * publishes kind 1163 events.
 */
export async function hasAnyActiveSubscription(
  pubkey: string
): Promise<{ allowed: boolean; reason: string; expires_at?: number }> {
  const [dbResult, nip63Result] = await Promise.all([
    checkDatabase(pubkey),
    hasNip63Membership(pubkey),
  ]);

  if (dbResult.allowed) {
    return dbResult;
  }

  if (nip63Result.allowed) {
    return {
      allowed: true,
      reason: "NIP-63 membership",
      ...(nip63Result.expires_at && { expires_at: nip63Result.expires_at }),
    };
  }

  return { allowed: false, reason: "no active subscription" };
}

async function checkDatabase(
  pubkey: string
): Promise<{ allowed: boolean; reason: string; expires_at?: number }> {
  const db = getSupabase();

  const { data, error } = await db
    .from("subscriptions")
    .select("expires_at")
    .eq("subscriber_pubkey", pubkey)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(1);

  if (error || !data || data.length === 0) {
    return { allowed: false, reason: "no active subscription" };
  }

  return {
    allowed: true,
    reason: "active subscription",
    expires_at: Math.floor(new Date(data[0].expires_at).getTime() / 1000),
  };
}

/**
 * Get the list of creator pubkeys this user has access to.
 * Used for fine-grained filtering on shared relays.
 */
export async function getAccessibleCreators(
  pubkey: string
): Promise<string[]> {
  const db = getSupabase();

  const { data, error } = await db
    .from("subscriptions")
    .select(
      `
      tier_id,
      tiers!inner (
        creator_pubkey
      )
    `
    )
    .eq("subscriber_pubkey", pubkey)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());

  if (error || !data) {
    return [];
  }

  const creatorPubkeys = new Set<string>();
  for (const sub of data) {
    const tier = sub.tiers as unknown as { creator_pubkey: string };
    if (tier?.creator_pubkey) {
      creatorPubkeys.add(tier.creator_pubkey);
    }
  }

  return Array.from(creatorPubkeys);
}
