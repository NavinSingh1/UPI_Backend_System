# PhonePe MERN Clone — Backend

A PhonePe-style payments backend built on Node/Express/MongoDB, with a **double-entry ledger**, **integer-paise money handling**, and the operational pieces a real payment service needs.

```bash
docker compose up                        # whole stack, one command
docker compose exec api-1 npm run seed   # load demo users
npm run test:unit                        # 97 tests, no infrastructure needed
```

The API is reachable at `http://localhost:8080` (through nginx). The app replicas themselves are not published — that's the point of the reverse proxy.

## Architecture

```
                        ┌──────────────────────────┐
   client ────────────► │  nginx  :8080            │
                        │  reverse proxy + LB      │
                        │  least_conn · gzip       │
                        │  edge rate limit 30r/s   │
                        └────┬────────┬────────┬───┘
                             │        │        │       passive health checks:
                        ┌────▼──┐ ┌──▼───┐ ┌──▼───┐    3 fails → out of rotation 15s
                        │ api-1 │ │api-2 │ │api-3 │    stateless · no background jobs
                        └────┬──┘ └──┬───┘ └──┬───┘
                             └────────┼────────┘
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
              ┌──────────┐     ┌────────────┐    ┌─────────────┐
              │ MongoDB  │     │   Redis    │    │   worker    │
              │ rs0      │     │ cache      │    │ queue       │
              │ (txns)   │     │ rate limit │    │ consumer    │
              └──────────┘     │ blacklist  │    │ + autopay   │
                               │ idempotency│    │   cron      │
                               │ queue      │◄───┤ retries/DLQ │
                               └────────────┘    └─────────────┘
```

Four things worth calling out:

**Load balancing** uses `least_conn`, not round-robin, because request cost here is wildly uneven — a PDF statement or an analytics aggregation takes far longer than a balance read, and round-robin would keep feeding work to an instance already busy with a slow one. Passive health checking (`max_fails=3 fail_timeout=15s`) pulls a dead instance out of rotation automatically.

**`proxy_next_upstream` deliberately excludes `non_idempotent`.** Retrying a failed `POST /transactions/send` at the proxy layer could double-charge someone. Money endpoints are protected by `Idempotency-Key` in the app, but the proxy should never be the thing that decides to replay a payment.

**Background work lives in its own process** (`worker.js`). Three API replicas would otherwise mean three autopay schedulers, so the replicas run with `DISABLE_WORKER=true` and the worker owns the notification consumer plus the cron.

**Redis stops being optional above one replica.** The in-memory fallbacks for the JWT blacklist, idempotency keys and rate-limit counters are per-process — without Redis a token revoked on api-1 would still work on api-2. The app logs an error at startup if it detects that combination.

---

## How money works here

Three design decisions matter more than any individual endpoint.

**1. Money is stored as integer paise, never floats.** `amount: Number` in BSON is an IEEE-754 double, so `4.35 * 100 === 434.99999999999994` and those errors compound once you start summing transactions. Every amount in the database is an integer number of paise (`amountPaise`, `balancePaise`). The API still speaks rupees — conversion happens once, at the boundary, in `src/utils/money.js`, which parses the decimal string rather than multiplying by 100.

**2. A double-entry ledger is the source of truth.** Every money movement writes exactly two `LedgerEntry` rows — one DEBIT, one CREDIT — that sum to zero, asserted before anything is written. `User.balancePaise` is a *materialized projection* of those entries, updated in the same transaction, so reads stay fast while drift remains detectable. `npm run reconcile` recomputes every balance from the ledger and exits non-zero if any account disagrees.

When one side isn't a user (topping up from a bank, paying a biller) the counter-entry uses an external account, so the books still balance:

| Type | DEBIT | CREDIT |
|---|---|---|
| `TRANSFER` | sender | receiver |
| `REFUND` | original receiver | original sender |
| `ADD_MONEY` | external `BANK` | user |
| `WITHDRAW` | user | external `BANK` |
| `BILL_PAY` | user | external `BILLER` |

**3. Debits are atomic and cannot overdraw.** The debit is a single conditional update where the guard and the write are the same operation:

```js
User.findOneAndUpdate(
  { _id: senderId, balancePaise: { $gte: amountPaise } },  // guard
  { $inc: { balancePaise: -amountPaise } }                  // write
)
```

This closes the read-then-write race that a `if (balance < amount)` check followed by a separate `save()` leaves open — two concurrent transfers could otherwise both pass the check. There's a regression test for exactly this: ten parallel ₹200 transfers against a ₹1,000 balance, of which exactly five may succeed.

On top of that, `src/services/ledgerService.js` wraps each movement in a real MongoDB transaction when the deployment is a replica set (which `docker compose` provides), and falls back to compensating writes on a standalone `mongod`. It detects which at startup.

**Everything that moves money goes through `postTransaction()`** — transfers, top-ups, withdrawals, bill payments, refunds, split settlements and autopay runs. There is one code path to audit.

---

## Feature set

**Auth & accounts** — JWT register/login, auto-assigned UPI IDs, MPIN setup, logout via token blacklist, change password, update profile, forgot/reset password over emailed OTP, and soft-delete account deactivation.

**Payments** — P2P transfers by phone or UPI ID, wallet top-up, withdrawal, mock utility bill payments, and full or partial refunds with an over-refund guard.

**Requests & splits** — request money from another user (PENDING → ACCEPTED/DECLINED/CANCELLED/EXPIRED), and split a bill across up to 20 people with exact-paise shares that always sum to the total.

**Autopay** — recurring payment mandates authorized by MPIN *once at creation* (the MPIN is never stored, matching how real e-mandates work), executed by a cron worker. Double-charging is prevented by the database: each run writes a `reference.periodKey` under a partial unique index, so a restarted or duplicated worker physically cannot charge twice for the same period.

**Insight** — paginated and filterable history, single-transaction detail with its ledger entries, monthly summary, spending analytics by auto-detected category with a month-over-month trend, 5-item mini-statement, and CSV/PDF statement export.

**QR** — generate a real `upi://pay` deep-link QR (PNG, SVG or data URL), optionally amount-prefilled, and resolve a scanned code back to a payee.

**Security** — Helmet headers, per-route rate limiting (Redis-backed when available so counters survive restarts), Joi validation on every route, **account-level** MPIN lockout after 5 failures (per-IP limits don't stop an attacker rotating IPs against one account), and UPI-style spending caps: per transaction, per day, per month, plus a daily transaction-count velocity check.

**Resilience** — a **circuit breaker** in front of SMTP (CLOSED → OPEN → HALF_OPEN, per-call timeouts, single-probe recovery) so a dead mail server fails fast instead of tying up requests, and a **durable message queue** (BullMQ on Redis) for notifications and OTP emails with exponential-backoff retries and an explicit dead-letter queue. Both are reportable at `/health` and `/api/admin/*`.

**Operations** — structured JSON logging (pino) with an `X-Request-Id` correlation id on every request and secrets redacted, centralized error handling, startup env validation, a `/health` probe reporting queue and breaker state, graceful shutdown on SIGINT/SIGTERM, nginx reverse proxy + load balancer, Docker Compose, and GitHub Actions CI that also verifies the ledger reconciles.

---

## Getting started

### With Docker (recommended)

```bash
cp .env.example .env      # optional: fill in SMTP to enable OTP emails
docker compose up
docker compose exec api npm run seed
```

Mongo runs as a single-node **replica set** on purpose — that's what enables real MongoDB transactions, so the ledger gets full ACID guarantees rather than the compensating-write fallback.

### Without Docker

```bash
npm install
cp .env.example .env      # set MONGODB_URI and JWT_SECRET at minimum
npm run seed              # demo users
npm run dev               # docs live at /api-docs, no generation step needed
```

Redis is entirely optional — leave `REDIS_URL` unset and caching, the JWT blacklist, OTP storage and idempotency keys all run on an in-memory fallback.

**Seeded accounts** (password `password123`, MPIN `1234`):

| Email | UPI | Opening balance |
|---|---|---|
| amit@example.com | amit123@phonepe | ₹5,000 |
| priya@example.com | priya456@phonepe | ₹3,000 |
| rahul@example.com | rahul789@phonepe | ₹1,500 |
| neha@example.com | neha012@phonepe | ₹8,000 |

### Upgrading an existing database

If you have data from before the paise/ledger change:

```bash
node scripts/migrate-to-paise.js --dry   # preview
npm run migrate                          # convert balances + amounts, backfill ledger & indexes
npm run reconcile                        # verify every balance matches the ledger
```

---

## Testing

```bash
npm run test:unit          # 97 tests, no infrastructure — instant
npm run test:queue         # real BullMQ against a real Redis (needs REDIS_URL)
npm run test:integration   # the real app over a real MongoDB
npm test                   # all three
```

The queue tests are worth knowing about: they run the actual BullMQ pipeline against a real Redis with only the mailer mocked, and assert that a transient failure retries with backoff, that an exhausted job lands in the dead-letter queue with its failure reason, that a `jobId` prevents duplicate emails, and that a job enqueued while the consumer is *down* is still delivered once it comes back — the durability property the old EventEmitter did not have.

To verify the proxy and load balancer, `nginx -t -c nginx/nginx.conf` validates the config, and with the stack up, repeatedly curling `http://localhost:8080/health` shows the `X-Instance-Id` header rotating across `api-1/2/3`. Stopping one replica (`docker compose stop api-2`) should leave requests succeeding on the other two.

Unit tests cover the money arithmetic, share splitting, ledger invariants, recurrence dates, category inference, UPI URI handling and CSV escaping — no database needed, so they run anywhere.

Integration tests drive the actual Express app. They use `MONGODB_URI` if set (CI provides a replica set, exercising the transactional path) and otherwise spin up `mongodb-memory-server` (standalone, exercising the fallback path). Both paths are legitimate and both are covered.

---

## API

### Auth — `/api/auth`
| Method | Route | Description |
|---|---|---|
| POST | `/register` | Create account; assigns a UPI ID and credits the opening balance through the ledger |
| POST | `/login` | Returns a Bearer token |
| GET | `/profile` | Current user (cached) |
| POST | `/setup-mpin` | Set or change the 4–6 digit MPIN |
| POST | `/logout` | Blacklists the current token |
| PUT | `/change-password` | Requires the current password |
| PUT | `/update-profile` | Update name and/or phone |
| POST | `/forgot-password` | Emails a 6-digit OTP (10 min expiry) |
| POST | `/reset-password` | Verify OTP, set new password |
| DELETE | `/account` | Soft-delete (deactivate) |

### Transactions — `/api/transactions`
| Method | Route | Description |
|---|---|---|
| POST | `/send` | Transfer by phone or UPI ID. Supports `Idempotency-Key` |
| GET | `/history` | `?page=&limit=&type=&status=&category=&from=&to=` (limit capped at 100) |
| GET | `/summary` | Current-month totals |
| GET | `/analytics` | `?months=3` — spend by category plus trend |
| GET | `/statement` | `?format=csv\|pdf&from=&to=` — file download |
| GET | `/:txnId` | Detail, including the two ledger entries |
| PATCH | `/:txnId/category` | Override the auto-detected category |
| POST | `/:txnId/refund` | Full or partial refund (receiver only) |

### Wallet — `/api/wallet`
| Method | Route | Description |
|---|---|---|
| GET | `/balance` | Current balance (cached) |
| GET | `/limits` | Remaining daily/monthly headroom |
| GET | `/mini-statement` | Last 5 transactions |
| GET | `/reconcile` | Verify the balance against the ledger |
| POST | `/add-money` | Top up from the linked bank |
| POST | `/pay-bill` | Pay a utility bill |
| POST | `/withdraw` | Withdraw to the linked bank |

### Payment requests — `/api/payment-requests`
`POST /` · `GET /?direction=incoming\|outgoing` · `POST /:id/accept` (MPIN) · `POST /:id/decline` · `POST /:id/cancel`

### Split bills — `/api/split-bills`
`POST /` · `GET /` · `GET /:id` · `POST /:id/settle` (MPIN)

### Recurring — `/api/recurring`
`POST /` (MPIN authorizes the mandate) · `GET /` · `POST /:id/pause` · `POST /:id/resume` · `DELETE /:id`

### Users — `/api/users`
`GET /search?upiId=` · `GET /me/qr?amount=&format=png\|svg\|dataurl` · `POST /parse-qr`

### Operations — `/api/admin`
| Method | Route | Description |
|---|---|---|
| GET | `/circuits` | Circuit breaker states, thresholds and counters |
| GET | `/queues` | Queue depth, retries in flight, dead-letter count |
| GET | `/queues/dead-letters` | What failed permanently, and why |

Plus `GET /health` (unauthenticated) which reports Mongo connectivity, queue mode, every circuit breaker, and a `degraded` flag when a dependency is down but the API is still serving.

## API documentation

`src/docs/openapi.js` is a hand-authored **OpenAPI 3.0.3** spec and the single source of truth for the docs. It covers all 48 operations with request/response schemas, examples, and the error cases each endpoint can actually return.

| Where | What |
|---|---|
| `http://localhost:5000/api-docs` | Interactive Swagger UI (auth persists between calls) |
| `http://localhost:5000/api-docs.json` | The raw spec, for client codegen |
| `npm run swagger` | Writes `swagger-output.json` from the spec |
| `npm run postman` | Regenerates `postman_collection.json` + `postman_environment.json` |
| `npm run docs` | Both |

The spec is served straight from the module, so the docs can't be stale relative to what's running. And `tests/unit/openapi.test.js` walks the real Express router and compares it against the spec **in both directions** — adding a route without documenting it, or documenting one that doesn't exist, fails the build. It also checks that every `$ref` resolves and that only the seven genuinely public endpoints opt out of bearer auth.

Previously this project used `swagger-autogen`, which had to boot `server.js` (so it needed a live MongoDB), emitted Swagger 2.0 with no schemas at all, and had silently drifted to documenting 9 of 47 routes. That dependency is gone.

### Postman

Import `postman_collection.json` and `postman_environment.json`. The collection is generated from the same spec, so it never falls behind, and it's built to be run top to bottom:

- Bearer auth is wired to `{{token}}` at the collection level; the seven public endpoints override it to `noauth`
- **"Log in"** captures `token`, `userId` and `myUpiId` into collection variables automatically
- Requests that create things capture their ids — `txnId`, `requestId`, `splitId`, `mandateId` — so the follow-up requests (`/api/transactions/{{txnId}}/refund`, `/api/split-bills/{{splitId}}/settle`, …) just work
- Every request asserts its expected status code, so the Collection Runner is a usable smoke test
- The 7 money endpoints carry an `Idempotency-Key: {{$guid}}` header, **disabled by default** — enable it and fire the same request twice to watch the response replay instead of charging again
- Optional query filters are included but disabled, so each request works unmodified

---

## Project structure

```
server.js                       API entrypoint: env check → DB → listen → graceful shutdown
worker.js                       worker entrypoint: queue consumer + autopay cron (no inbound port)
nginx/nginx.conf                reverse proxy + load balancer (least_conn, passive health checks)
src/
  app.js                        Express app (no listen/DB) so tests can import it
  docs/
    openapi.js                  the OpenAPI 3.0.3 spec — source of truth for Swagger AND Postman
  queues/
    connection.js               BullMQ's own Redis connection (needs maxRetriesPerRequest: null)
    notificationQueue.js        enqueue + DLQ + stats, falls back in-process without Redis
    notificationWorker.js       the consumer: retries, then dead-letters
    processors.js               job handlers, free of BullMQ types so they're unit-testable
  config/
    db.js                       Mongo connection
    redis.js                    optional Redis client
    limits.js                   spending caps & lockout config, in paise
  models/                       User, Transaction, LedgerEntry, PaymentRequest, SplitBill, RecurringPayment
  services/
    ledgerService.js            THE money engine — atomic debits, balanced entries, reconciliation
    ledgerEntries.js            pure: which side is debited + the balancing invariant
    statementService.js         CSV/PDF statement generation
  controllers/                  auth, txn, wallet, user, paymentRequest, splitBill, recurring
  routes/                       one router per controller
  middlewares/
    authMiddleware.js           JWT + blacklist + isActive check
    verifyMpin.js               MPIN check with account-level lockout
    enforceLimits.js            per-transaction / daily / monthly / velocity caps
    idempotency.js              Idempotency-Key replay
    rateLimiter.js              per-route limiters (Redis-backed when available)
    validate.js                 Joi middleware
    errorHandler.js             centralized errors + 404
    requestLogger.js            pino-http + X-Request-Id
  utils/                        money, cache, upi, categories, recurrence, mpinLockout, serializers, ApiError, …
  workers/
    recurringWorker.js          autopay cron + payment-request expiry sweep
scripts/
  migrate-to-paise.js           one-time migration from the float schema
  reconcile.js                  ledger vs. cached balance audit
  generate-postman.js           derives the Postman collection from the OpenAPI spec
tests/
  unit/                         no database required
  integration/                  full app over a real MongoDB
```

---

## Breaking changes

Coming from the earlier version of this project:

1. **`amount` → `amountPaise` in the database.** The API still accepts and returns rupees as `amount`, and also returns `amountPaise` for exact math. Run `npm run migrate` on existing data.
2. **`User.balance` → `User.balancePaise`.** Same migration handles it; API responses still include `balance` in rupees.
3. **`GET /api/transactions/history`** returns `{ transactions, pagination }`, not a bare array.
4. **New accounts start with a ledger-backed `ADD_MONEY` opening-balance transaction**, so a brand-new user's history has one entry rather than none.
5. **Amounts with more than 2 decimal places are rejected** (`400`) instead of being silently rounded.
6. **Validation is stricter**: passwords ≥ 8 chars, phone exactly 10 digits, `billerName` required, MPIN exactly 4–6 digits.
7. **`?limit=` is capped at 100.**
8. Outbound payments are now subject to spending limits (₹1,00,000 per transaction/day and 20 transactions/day by default) — configurable via `LIMIT_*` env vars.
