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
 * Check if an npub has an active subscription to any creator on the gated relay.
 * Returns the list of creator IDs this npub has access to.
 */
export async function getAccessibleCreators(
  npub: string
): Promise<string[]> {
  const db = getSupabase();

  const { data, error } = await db
    .from("subscriptions")
    .select(
      `
      tier_id,
      tiers!inner (
        creator_id
      )
    `
    )
    .eq("subscriber_npub", npub)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());

  if (error || !data) {
    return [];
  }

  // Extract unique creator IDs
  const creatorIds = new Set<string>();
  for (const sub of data) {
    const tier = sub.tiers as unknown as { creator_id: string };
    if (tier?.creator_id) {
      creatorIds.add(tier.creator_id);
    }
  }

  return Array.from(creatorIds);
}

/**
 * Simple check: does this npub have ANY active subscription?
 * Used by the auth proxy to gate relay access.
 */
export async function hasAnyActiveSubscription(
  npub: string
): Promise<boolean> {
  const db = getSupabase();

  const { count } = await db
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("subscriber_npub", npub)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());

  return (count ?? 0) > 0;
}
