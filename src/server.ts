import Fastify from "fastify";
import { hasAnyActiveSubscription, getAccessibleCreators } from "./access.js";

const app = Fastify({ logger: true });

/**
 * Auth proxy endpoint called by strfry's auth plugin.
 * strfry sends the authenticated npub, we verify subscription status.
 *
 * This endpoint is called by the strfry write policy plugin
 * and the auth proxy for read access control.
 */

// Check if an npub has access to the gated relay
app.post<{ Body: { npub: string } }>("/check-access", async (request) => {
  const { npub } = request.body;

  if (!npub) {
    return { allowed: false, reason: "npub is required" };
  }

  const hasAccess = await hasAnyActiveSubscription(npub);

  return {
    allowed: hasAccess,
    reason: hasAccess ? "active subscription" : "no active subscription",
  };
});

// Get list of creator IDs this npub can access (for fine-grained filtering)
app.post<{ Body: { npub: string } }>(
  "/accessible-creators",
  async (request) => {
    const { npub } = request.body;

    if (!npub) {
      return { creators: [] };
    }

    const creators = await getAccessibleCreators(npub);
    return { creators };
  }
);

// Health check
app.get("/health", async () => {
  return { status: "ok", service: "nostreon-relay-auth" };
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
