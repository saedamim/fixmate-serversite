# FixMate Server

Express API for FixMate, a home and device repair marketplace. Customers book services, technicians manage their own
services and bookings, admins approve services, and customers pay for completed work with Stripe Checkout (test mode).

Stack: Node.js (ES modules), Express 5, MongoDB, Better Auth (email/password + Google, JWT plugin), Stripe, ImgBB.

## Run locally

```
npm install
cp .env.example .env     # then fill in the values (see below), or create .env by hand
npm run dev              # http://localhost:8000
npm run seed             # 12 approved demo services (safe to repeat, never duplicates)
```

## Environment variables (names only; never commit values)

| Name | Purpose |
|---|---|
| `MONGODB_URI` | MongoDB connection string (database `fixmate`). |
| `BETTER_AUTH_URL` | This API's own public https address, no trailing slash. Used by Better Auth and to verify JWTs. |
| `BETTER_AUTH_SECRET` | Long random secret for Better Auth. |
| `FRONTEND_URL` | The deployed frontend's https origin, no trailing slash. CORS, trusted origin, Google redirect and Stripe return URLs. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. Authorized redirect URI: `<FRONTEND_URL>/api/auth/callback/google`. |
| `IMGBB_API_KEY` | Image uploads. |
| `STRIPE_SECRET_KEY` | Stripe test key (`sk_test_...`). Live keys are refused. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Stripe webhook that points at `<BETTER_AUTH_URL>/api/payments/webhook`. |
| `PORT` | Local port only (default 8000). Not needed on Vercel. |

## Authentication and roles

Better Auth runs on this server (`/api/auth/*`). New users get the role `customer`; the `role` field cannot be set
from the request. Protected routes need `Authorization: Bearer <JWT>`. The token is verified against this server's JWKS
(`verifyToken`), then `verifyRole(...)` checks the role. Missing/invalid token: `401`. Wrong role: `403`.

## API

Public
- `GET /` health check
- `GET /api/services` approved and available services. Query: `search`, `category`, `mode`, `sort`
  (`newest`, `price-low-to-high`, `price-high-to-low`), `page`, `limit`
- `GET /api/services/:id`
- `POST /api/upload/image` multipart field `image` (PNG, JPEG, WebP, GIF, up to 2 MB) uploaded to ImgBB
- `POST /api/payments/webhook` Stripe only, signature checked

Technician
- `GET /api/services/mine`, `POST /api/services`, `PUT /api/services/:id`, `DELETE /api/services/:id`
  (own services only; new or edited services wait for admin approval)
- `GET /api/bookings/technician`, `PATCH /api/bookings/technician/:id/status`

Customer
- `POST /api/bookings`, `GET /api/bookings/my`, `GET /api/bookings/:id`, `PATCH /api/bookings/:id/cancel`
- `POST /api/payments/create-checkout-session`, `GET /api/payments/verify`, `GET /api/payments/my`

Admin
- `GET /api/admin/stats|users|services|bookings|transactions`, `PATCH /api/admin/services/:id/status`

### Booking rules
- One active booking per customer and service (unique partial index).
- Customer can cancel only a `requested` booking.
- Technician moves a booking only along: `requested` to `accepted` or `rejected`, `accepted` to `in_progress`,
  `in_progress` to `completed` (with `finalAmount`). Any other move returns `409`.
- Price, service title and technician always come from the database, never the request.

### Payments
- Only a `completed` and `unpaid` booking can be paid. The amount is read from the booking's `finalAmount` on the server.
- One open checkout per booking. A paid booking cannot be paid twice (a duplicate charge is flagged for refund).
- A payment becomes `paid` only after the Stripe session is confirmed (verify endpoint or signed webhook); repeating
  either is safe.

## Data

Application collections: `services`, `bookings`, `payments`, plus Better Auth's `user` collection.
Better Auth also creates `session`, `account`, `verification` and `jwks` by itself.

## Scripts
- `npm run seed` demo services.
- `node scripts/assign-technicians.js` assigns the demo services to real technician accounts.
- `node scripts/promote-admin.js <email>` dry run that reports whether a user could be made admin.

## Tests
`npm test`. Several test files call a running server and use real data, so point `BETTER_AUTH_URL` / `API_URL` at a
local server and a test database first.

## Deploy (Vercel)
Set every variable above in the backend project, redeploy, add the Stripe webhook URL, and add the Google redirect URI.
