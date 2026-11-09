# goforsale.co.uk — UK marketplace MVP

This is a runnable full-stack starter for a UK buy/sell marketplace. It includes:
- Customer registration and sign-in (passwords hashed with bcrypt)
- Seller listings with image upload
- Category and text search
- Fixed-price basket and demo order preparation
- Auction listings and basic bid submission
- Buyer order history
- Admin-only marketplace summary endpoint
- SQLite database and server-side sessions

## Run locally

Requirements: Node.js 20 or newer.

```bash
cp .env.example .env
npm install
node --env-file=.env server.js
```

Open http://localhost:3000

On Windows PowerShell, copy the environment file with:
```powershell
Copy-Item .env.example .env
```

Change `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `.env` before use.

## Create the administrator

For the first admin account, register using the email in `ADMIN_EMAIL`, then promote it in SQLite:

```sql
UPDATE users SET role='admin' WHERE email='admin@example.com';
```

You can run this using a SQLite database browser, or the `sqlite3` command if installed. Do not expose database access publicly.

## Important: this is an MVP, not ready to accept live customers or money

Without sandbox credentials, the demo checkout endpoint creates an order in `payment_pending` status and does not collect money. It reserves the listings pending a payment workflow. Do not treat this as a completed sale.

Before public launch, implement and test:
1. PayPal marketplace onboarding for sellers, marketplace payments, platform commission, refunds, chargebacks and payout reconciliation.
2. Atomic stock/order state transitions and payment webhooks (never trust a browser success redirect).
3. Email verification, password reset, MFA for administrators, CSRF protection, stronger session/cookie configuration and account lockout.
4. UK consumer-law workflows: seller/business status, distance-selling information, cancellation/returns, complaints, prohibited/restricted goods, and clear marketplace terms.
5. UK GDPR privacy notice, lawful basis, retention/deletion, data-subject request process, processor agreements and breach response.
6. Shipping labels/tracking integration, delivery options, seller/buyer messaging, moderation, reporting and dispute handling.
7. Production database, backups, monitoring, malware scanning for uploads, image processing, CDN, HTTPS, security testing and deployment pipeline.

The admin summary endpoint expects a user with `role='admin'`. The environment variables are a setup aid; this starter does not automatically elevate an account.

## Data

SQLite database and session database are created under `data/`; uploaded images are stored under `uploads/`. These folders are ignored by git. Back them up and protect them if deploying.

## PayPal marketplace sandbox

Use a PayPal Complete Payments Platform sandbox app. Set the client ID, secret,
partner merchant ID, partner attribution code and the app origin in .env.
Start with `node --env-file=.env server.js`. The integration uses PayPal's sandbox
API exclusively.

1. Sign up as a marketplace seller, choose **Connect PayPal sandbox** and complete
   PayPal onboarding. Return to goforsale.co.uk to verify the seller connection.
2. Publish a listing from that account. Seeded listings are demo-only.
3. Sign in as a separate buyer, add items from one seller and use sandbox checkout.
   For an ended auction, sign in as the winning bidder and select **Pay winning bid**.
4. Approve with a sandbox buyer account. On return, goforsale.co.uk captures and checks
   the payment before marking the order paid. Resume interrupted checkout from
   **Your orders**.

Sandbox orders are limited to one seller. Pending orders keep listings reserved
and can be resumed by the buyer. Reservation expiry and cancellation, webhooks,
refund handling, platform commission and shipping are still needed before live
use. Live marketplace payments also require PayPal partner approval.

## Railway staging deployment

1. Extract the archive and commit the contents of `forsale-platform` to a private
   GitHub repository. In Railway, create a project from that repository. If the
   folder is nested in the repository, set it as the service root directory.
2. Attach a volume at `/app/storage` to persist marketplace data, sessions and
   uploaded images. Railway exposes the mount path to the application. Keep a
   single replica while using SQLite.
3. Set `SESSION_SECRET` to a random value of at least 32 characters. The
   container runs in production mode and uses secure session cookies.
4. Generate a Railway domain under the service's Public Networking settings.
   Open that HTTPS URL and verify registration, login and listing creation.
   Restart the service and confirm your listing and its uploaded image survive.
5. To test PayPal, set the five sandbox variables in `.env.example` in Railway.
   Set `PAYPAL_RETURN_ORIGIN` to the generated HTTPS origin. Verify onboarding
   and payment using separate sandbox seller and buyer accounts.
6. When ready to attach the custom domain, add `goforsale.co.uk` in Railway and
   enter the DNS records Railway supplies at the domain registrar. Update
   `PAYPAL_RETURN_ORIGIN` to the new HTTPS origin and retest PayPal redirects.

The Dockerfile installs native SQLite dependencies. Railway uses `/health`
to check the service before routing traffic to a new deployment.

## Classified Ads

Set `CLASSIFIED_FEE_PENCE=299` in Railway Variables for the agreed £2.99 fee
and configure the PayPal sandbox variables. The local environment example
already includes the same fee. The fee is charged to the seller and
paid to the platform's sandbox merchant account. The seller sees and accepts the fee before continuing to PayPal.
The ad stays private until the server confirms the fee capture. Buyers can
then view the details and message the seller through the marketplace inbox. They arrange payment and delivery
directly. An interrupted fee payment can be resumed from Basket & orders.


## Buyer and seller messages

Sign in and select **Contact seller** on a public listing to start a
conversation. Sellers and buyers can find the thread and reply under
**Messages**. Threads and unread status are stored in SQLite and are visible
only to the buyer and seller. Classified ads use the same inbox for contact.

### Email copies

Each new marketplace message queues a plain-text copy for the other participant
at the email address on their account. The sender's email address is not used as
the From or Reply-To address. Recipients sign in to Messages to reply.

Set `RESEND_API_KEY`, `MAIL_FROM` (a sender on a domain verified in Resend),
and `MAIL_SITE_URL` (your public HTTPS origin) in Railway Variables. Keep one
replica so only one delivery worker runs. Pending copies are retained in SQLite
and retried if delivery fails. Messages sent after this update and before Resend
is configured are queued until delivery is enabled.

### Additional Business listing slots

Business accounts start with 200 concurrent listing slots. Configure
`BUSINESS_SLOT_PACK_FEE_PENCE` and PayPal sandbox to offer 50 additional slots
per purchase. The account shows the price before checkout. Each verified
payment permanently increases the account allowance by 50, and sellers can
buy more packs. The separate classified listing fee still applies.

The Business Shop costs £24 per 30 days and is renewed manually. A paid Shop
is required to publish new Business listings. Existing listings stay visible
when a Shop expires. The one-time price for 50 reusable extra slots is £3 by
default. Checkout uses PayPal sandbox until live payments are implemented.

### Content screening

Set `OPENAI_API_KEY` in Railway Variables to enable screening for account
display names, listings and photos, messages, and feedback. New submissions
are rejected if screening is unavailable. Uploads are served only once attached
to an eligible listing. The service sends submitted text and images to OpenAI
for screening, so describe this processing in the marketplace privacy notice.
Previously published content is outside this submission check and requires
separate review. Automated decisions can miss prohibited material or flag
legitimate content.

## Deploy to Render

Use the complete project, including `package-lock.json` and `Dockerfile`.
Select the directory containing `package.json`, `server.js` and `public/`
as the Render Root Directory. If those files are at the repository root,
leave Root Directory blank.

For a Docker web service, use the provided Dockerfile. For an existing
native Node web service, remove any `NODE_VERSION` override that selects a
different major version, set Build Command to `npm ci`, and set Start Command
to `npm start`. The package pins Node to major version 22.

Set Health Check Path to `/health`. Set `NODE_ENV=production`,
`SESSION_SECRET` (a random secret of at least 32 characters), and
`TRUST_PROXY=1` in the web service environment. For persistent data on a
paid service, attach a disk at `/app/storage` and set
`FORSALE_STORAGE_DIR=/app/storage`. Keep one service instance for SQLite.
After committing changes to the connected branch, use **Manual Deploy →
Clear build cache & deploy** if the service has been using Yarn or Node 26.
