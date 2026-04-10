import { createClient, SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Check if a pubkey has an active subscription to any creator on the gated relay.
 * Returns access status and the earliest subscription expiry for caching.
 */
export async function hasAnyActiveSubscription(
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
