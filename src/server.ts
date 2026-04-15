import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hasAnyActiveSubscription, getAccessibleCreators } from "./access.js";

const app = Fastify({ logger: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const nip11Example = JSON.parse(
  readFileSync(join(__dirname, "../examples/nip11-example.json"), "utf-8")
);

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

/**
 * Reference NIP-11 document demonstrating the `access_control` field proposed
 * in https://github.com/nostr-protocol/nips/pull/2318. Served on both `GET /`
 * (with `Accept: application/nostr+json`) and `GET /nip11-example` so clients
 * and reviewers can fetch a live, runnable example of the shape.
 */
const sendNip11 = async (_request: FastifyRequest, reply: FastifyReply) => {
  reply.header("Content-Type", "application/nostr+json");
  reply.header("Access-Control-Allow-Origin", "*");
  return nip11Example;
};

app.get("/nip11-example", sendNip11);

app.get("/", async (request: FastifyRequest, reply: FastifyReply) => {
  const accept = String(request.headers["accept"] || "");
  if (accept.includes("application/nostr+json")) {
    return sendNip11(request, reply);
  }
  return {
    service: "relay-auth",
    message:
      "Send Accept: application/nostr+json to see the reference NIP-11 document, or GET /nip11-example.",
  };
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
