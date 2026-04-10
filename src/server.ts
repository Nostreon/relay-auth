import Fastify from "fastify";
import { hasAnyActiveSubscription, getAccessibleCreators } from "./access.js";

const app = Fastify({ logger: true });

/**
 * Auth proxy endpoint called after NIP-42 authentication.
 * The relay sends the authenticated pubkey, we verify subscription status.
 */

// Check if a pubkey has access to the gated relay
app.post<{
  Body: {
    pubkey: string;
    action?: "connect" | "read" | "write";
    kind?: number;
    relay?: string;
  };
}>("/check-access", async (request) => {
  const { pubkey } = request.body;

  if (!pubkey) {
    return { allowed: false, reason: "pubkey is required" };
  }

  const result = await hasAnyActiveSubscription(pubkey);

  return {
    allowed: result.allowed,
    reason: result.reason,
    ...(result.expires_at && { expires_at: result.expires_at }),
  };
});

// Get list of creator pubkeys this user can access (for fine-grained filtering)
app.post<{ Body: { pubkey: string } }>(
  "/accessible-creators",
  async (request) => {
    const { pubkey } = request.body;

    if (!pubkey) {
      return { creators: [] };
    }

    const creators = await getAccessibleCreators(pubkey);
    return { creators };
  }
);

// Health check
app.get("/health", async () => {
  return { status: "ok", service: "relay-auth" };
});

const start = async () => {
  const port = parseInt(process.env.PORT || "3003");
  const host = process.env.HOST || "0.0.0.0";

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
    process.exit(1);
  }

  await app.listen({ port, host });
  console.log(`Relay auth service running on ${host}:${port}`);
};

start();
