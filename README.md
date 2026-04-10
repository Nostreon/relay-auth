# relay-auth

Access Control Service (ACS) for gated Nostr relays. Verifies whether an authenticated pubkey is authorized to access a relay, based on subscription status or other external criteria.

Built as a reference implementation for [NIP-XX: Relay Access Control via Authentication Callbacks](https://github.com/nostr-protocol/nips/issues/XXX).

## How it works

```
Client → (NIP-42 AUTH) → Relay → (POST /check-access) → relay-auth → Database
```

1. Client connects to a gated relay and completes NIP-42 authentication
2. Relay extracts the authenticated pubkey and calls this service
3. This service checks the database for active subscriptions
4. Relay grants or denies access based on the response

## API

### `POST /check-access`

Check if a pubkey has access to the gated relay.

**Request:**

```json
{
  "pubkey": "abc123...",
  "action": "connect",
  "kind": 30023,
  "relay": "wss://premium.example.com"
}
```

Only `pubkey` is required. `action`, `kind`, and `relay` are optional.

**Response:**

```json
{
  "allowed": true,
  "reason": "active subscription",
  "expires_at": 1720000000
}
```

### `POST /accessible-creators`

Get the list of creator pubkeys this user can access (for per-creator filtering).

**Request:**

```json
{
  "pubkey": "abc123..."
}
```

**Response:**

```json
{
  "creators": ["def456...", "ghi789..."]
}
```

### `GET /health`

Health check endpoint.

## Setup

### Requirements

- Node.js 22+
- A database with `subscriptions` and `tiers` tables (this implementation uses Supabase/Postgres)

### Database schema

The service expects these tables:

```sql
create table tiers (
  id uuid primary key default gen_random_uuid(),
  creator_pubkey text not null,    -- creator's hex pubkey
  name text not null,
  price_cents integer not null,
  cadence text not null            -- 'monthly' or 'yearly'
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscriber_pubkey text not null, -- subscriber's hex pubkey
  tier_id uuid references tiers(id),
  status text not null,            -- 'active', 'cancelled', 'expired'
  expires_at timestamptz not null
);
```

### Run locally

```bash
cp .env.example .env
# Edit .env with your Supabase credentials

npm install
npm run dev
```

### Run with Docker

```bash
cp .env.example .env
# Edit .env with your Supabase credentials

docker compose up
```

This starts the ACS, a strfry gated relay, and an nginx reverse proxy.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase API URL | required |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | required |
| `PORT` | Server port | `3003` |
| `HOST` | Bind address | `0.0.0.0` |

## Adapting to your database

This implementation uses Supabase, but the ACS pattern works with any database. To adapt:

1. Replace the Supabase client in `src/access.ts` with your database client
2. Update the queries to match your schema
3. The HTTP API (`src/server.ts`) stays the same

The key contract is simple: given a pubkey, return whether they have access and optionally which creators they can see.

## Architecture

This service is designed to sit between a Nostr relay and a database:

```
                    ┌─────────────────┐
                    │   nginx proxy   │
                    └────┬───────┬────┘
                         │       │
              ┌──────────┘       └──────────┐
              │                             │
     ┌────────▼────────┐          ┌─────────▼────────┐
     │  strfry (gated) │          │   relay-auth      │
     │  NIP-42 auth    │─────────▶│   (this service)  │
     └─────────────────┘  POST    └────────┬──────────┘
                        /check-access      │
                                  ┌────────▼──────────┐
                                  │  Database          │
                                  │  (subscriptions)   │
                                  └───────────────────┘
```

## Related

- [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) -- Authentication of clients to relays
- [NIP-43](https://github.com/nostr-protocol/nips/blob/master/43.md) -- Relay Access Metadata and Requests
- [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) -- Relay Management API

## License

MIT
