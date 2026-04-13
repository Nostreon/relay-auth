# relay-auth

Access control service for gated Nostr relays. Verifies whether an authenticated pubkey is allowed to access a relay, based on NIP-63 membership events and/or a database of active subscriptions.

Built as a reference implementation for [NIP-63: Exclusive Content (PR #2156)](https://github.com/nostr-protocol/nips/pull/2156) and the broader pattern of [Relay Access Control via Authentication Callbacks](https://github.com/nostr-protocol/nips/issues/2311).

## How it works

```
Client → (NIP-42 AUTH) → Relay → (POST /check-access) → relay-auth ─┬─▶ Database (subscriptions)
                                                                     └─▶ Gated relay (kind 1163 events)
```

1. Client connects to a gated relay and completes NIP-42 authentication
2. Relay extracts the authenticated pubkey and calls this service
3. This service checks **two sources in parallel**:
   - **NIP-63 path**: queries the gated relay for kind 1163 membership events tagged with the pubkey, then validates the NIP-40 `expiration` tag
   - **Database path**: looks for an active subscription row in Supabase
4. Relay grants or denies access based on the response

The two paths are independent. The NIP-63 path is the protocol-native fallback that lets *any* payment provider grant access by publishing kind 1163 events, with no shared database integration required. The database path is for platforms that already track subscriptions internally and want richer metadata (which tier, which creator, etc.).

## Why both paths?

- **NIP-63 alone** is portable but lossy. You only know "this pubkey has a valid membership until time T." You don't know what they're subscribed to.
- **Database alone** locks the relay to one platform. Other Nostr clients/apps can't grant access.
- **Both together** means a platform can run its own DB for richer features while still respecting kind 1163 events from third parties, and other relays can adopt the same service with just the NIP-63 path enabled.

## NIP-63 events

A kind 1163 membership event looks like:

```json
{
  "kind": 1163,
  "pubkey": "<payment-provider>",
  "tags": [
    ["p", "<subscriber-pubkey>"],
    ["expiration", "1735689600"]
  ],
  "content": ""
}
```

- The `p` tag identifies the subscriber
- The `expiration` tag (NIP-40) carries the unix timestamp when access ends
- The event is signed by whoever verified the payment (a platform, a Lightning service, etc.)

When this service receives a `/check-access` request, it queries the gated relay with `{"kinds":[1163], "#p":[<subscriber>], "limit":10}` and looks for any event whose `expiration` is in the future.

## API

### `POST /check-access`

```json
// request
{ "pubkey": "abc123...", "relay": "wss://premium.example.com" }

// response
{ "allowed": true, "reason": "NIP-63 membership", "expires_at": 1735689600 }
```

`reason` is one of:
- `"active subscription"` — matched a row in the database
- `"NIP-63 membership"` — matched a kind 1163 event
- `"no active subscription"` — neither source had a valid record

### `POST /accessible-creators`

```json
// request
{ "pubkey": "abc123..." }

// response
{ "creators": ["def456...", "ghi789..."] }
```

Returns the list of creator pubkeys this user has paid for. Used by relays that host content from multiple creators and want to filter events per-subscriber. (This endpoint reads from the database only; kind 1163 events don't carry creator identity in the standard tag set.)

### `GET /health`

Health check.

## Setup

### Requirements

- Node.js 22+
- A WebSocket-reachable Nostr relay where kind 1163 events live
- (Optional) A Postgres/Supabase database with `subscriptions` and `tiers` tables for the database path

### Database schema (optional)

If you're using the database path, the service expects:

```sql
create table tiers (
  id uuid primary key default gen_random_uuid(),
  creator_pubkey text not null,
  name text not null,
  price_cents integer not null,
  cadence text not null
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  subscriber_pubkey text not null,
  tier_id uuid references tiers(id),
  status text not null,
  expires_at timestamptz not null
);
```

If you only want the NIP-63 path, leave `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` unset and the database checks will return "no record." The NIP-63 check still runs.

### Run locally

```bash
cp .env.example .env
# Edit .env

npm install
npm run dev
```

### Run with Docker

```bash
cp .env.example .env
docker compose up
```

This starts the access control service, a strfry gated relay (which holds the kind 1163 events), and an nginx reverse proxy.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `GATED_RELAY_URL` | WebSocket URL of the relay where kind 1163 events live | `ws://strfry-gated:7777` |
| `SUPABASE_URL` | Supabase API URL (optional, for database path) | — |
| `SUPABASE_SERVICE_KEY` | Supabase service role key (optional) | — |
| `PORT` | Server port | `3003` |
| `HOST` | Bind address | `0.0.0.0` |

## Adapting to your stack

The two paths are independent, so you can use this service in three ways:

1. **NIP-63 only** — point `GATED_RELAY_URL` at the relay that holds your membership events, leave Supabase unset. Any payment provider that publishes kind 1163 events grants access.
2. **Database only** — point `SUPABASE_URL` at your DB, point `GATED_RELAY_URL` at an empty relay (or a non-existent one; the WebSocket connection failure is handled gracefully).
3. **Both** — the default. Database for your platform's native subscriptions, NIP-63 for everything else.

To swap Supabase for another database, replace the `createClient` and queries in [`src/access.ts`](src/access.ts). The HTTP API stays the same.

## Architecture

```
                    ┌─────────────────┐
                    │   nginx proxy   │
                    └────┬───────┬────┘
                         │       │
              ┌──────────┘       └──────────┐
              │                             │
     ┌────────▼────────┐          ┌─────────▼────────┐
     │  strfry (gated) │◀─────────│   relay-auth      │
     │  NIP-42 auth    │  REQ     │   (this service)  │
     │  kind 1163      │  1163    └────────┬──────────┘
     └────────┬────────┘                   │
              │                            ▼
              │ POST /check-access  ┌──────────────────┐
              └────────────────────▶│   Database        │
                                    │   (subscriptions) │
                                    └───────────────────┘
```

## Related

- [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) — Authentication of clients to relays
- [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md) — Expiration timestamp
- [NIP-63 (PR #2156)](https://github.com/nostr-protocol/nips/pull/2156) — Exclusive Content
- [NIP-88 (PR #866)](https://github.com/nostr-protocol/nips/pull/866) — Recurring Subscriptions
- [Nostreon/nip88-subscriptions](https://github.com/Nostreon/nip88-subscriptions) — companion reference: NIP-88 event builders + subscription lifecycle

## License

MIT
