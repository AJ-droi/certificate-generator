# Certificate Generator → document verification platform

Companies upload their certificate/report templates, issue documents with a QR code, and partners scan the code to confirm a document is genuine, unaltered and still valid.

## How it works

1. **A company signs up.** It gets its own users, templates, documents and an Ed25519 signing key. The private key is encrypted with `APP_SECRET` and never leaves the server.
   **It can't issue anything until it's verified** (see [Company verification](#company-verification)): it sends its registered name, registration number and website domain, proves it controls the domain with a DNS record, and platform staff check the registration.
2. **An admin adds a template**, in one of two ways:
   - **Upload the company's PDF form (recommended).** Draw a box on the page wherever information goes and say what it is; that creates the input field. Place the QR code, signatures and document number the same way. The design stays exactly as it is — data is printed onto the original pages.
   - **Write an HTML layout** with Handlebars placeholders, for developers or documents with long variable tables.

   Saving changes creates a new version; documents keep the version they were made with.
3. **An issuer fills in the form** generated from the fields — including tables, which can be pasted from Excel — and submits it.
4. **An approver issues it.** A different person must approve (can be turned off per company). On issue the document is locked, the content is signed and the approver's name/signature is added. The official PDF, with a QR code pointing to `/v/<code>`, is made a moment later by a background job; until then the dashboard shows "Preparing PDF…" and the verify page says the PDF is being prepared (the document itself already verifies).
5. **A partner scans the QR code** and sees:
   - **Valid** — issued by a verified company (its registered name, registration number and domain are shown) and unchanged since signing
   - **Issuer not verified** / **Issuer suspended** — the signature is fine, but the account that issued it isn't a company we've confirmed, or has been suspended
   - **Revoked** — with the reason the company gave
   - **Superseded** — with a link to the corrected version
   - **Failed integrity check** — the stored record no longer matches its signature
   
   They can view the full document, download the official PDF, or pick the PDF they were sent to check it byte-for-byte (in their browser, no upload).

Mistakes in an issued document are fixed with a **correction**: a new draft (`…-R1`) that, once issued, marks the original as superseded. Every action is recorded in the activity log.

### Why the QR can't just be copied onto a fake

The verify page shows the real contents of the document. A forger who copies a genuine QR onto an edited certificate sends the partner to a page showing the *original* details, which won't match. Verification codes are 120-bit random values, so they can't be guessed or enumerated.

## Quick start

Requires Node 22.9+ and Docker (for Postgres), or your own PostgreSQL.

```bash
npm install
npx puppeteer browsers install chrome   # Chrome for making PDFs (skip if PUPPETEER_EXECUTABLE_PATH is set)
cp .env.example .env                    # set APP_SECRET (openssl rand -base64 48)
npm run db:up                           # Postgres in Docker, port 5433 (also creates the test database)
npm run db:migrate                      # create the tables
npm run seed:demo                       # optional: demo company, 3 users, sample certificates
npm run dev                             # http://localhost:3100, restarts on changes
```

- Dashboard: `http://localhost:3100/app`
- Verify page: `http://localhost:3100/` (enter a code) or scan a QR
- Staff dashboard: `http://localhost:3100/platform` (create an account with `npm run staff -- create --email you@example.com --name "You"`)
- Demo logins (password `demo-password-123`): `admin@demo.test`, `inspector@demo.test` (issuer), `approver@demo.test`

Logs are JSON; for readable output locally run `npm run dev | npx pino-pretty`.

### Changing the database

Tables only change through migrations in `src/migrations/`. After editing `src/entities/`:

```bash
npm run db:migrate                          # bring your database up to date first
npm run db:migration:generate -- AddSomething   # writes src/migrations/<time>-AddSomething.js
# review the file, then:
npm run db:migrate
```

`npm run db:status` lists applied and pending migrations; `npm run db:revert` undoes the last one. A database created before migrations existed (by the old automatic sync) is adopted by the first `db:migrate` if it only needs additions.

## Company verification

Anyone can sign up and call their company "Shell". Verification is what stops that from producing documents partners trust:

1. **The company asks.** Settings → Company verification: registered name, registration number, country and website domain.
2. **It proves the domain.** It adds a TXT record `_docverify.<domain>` with the value shown, then clicks *Check DNS record*. A domain can only be verified by one company.
3. **Platform staff review it** in the staff dashboard at **`/platform`**: check the name and registration number against the official registry (e.g. the CAC search in Nigeria) and that the person asking works there, then **Verify** or **Reject** (with a reason the company sees).

Once verified, the company name and verified details are locked, and every document signs them in (`signedPayload.org.verified`). **Suspending** a company stops it issuing and turns everything it issued to **Issuer suspended** on the verify page; it can still revoke. **Reinstate** undoes it. Staff actions show in the company's activity log as "Name (platform staff)".

### Staff dashboard (`/platform`)

- **Overview** — companies waiting for review, counts by status, documents issued and QR scans in the last 30 days, and companies whose documents are being scanned and coming back *not valid* (tampered, revoked, from an unverified or suspended issuer) — a sign forged or cancelled documents are in circulation.
- **Companies** — search by name, ID, domain or registration number; filter by status; sort by invalid scans.
- **Company page** — submitted details and DNS status, warnings (name looks like an already-verified company, admin email not on the company's domain, domain not proven, invalid scans), people, template/document counts, recent documents (numbers and status only) and its activity log. Actions: *Check DNS now*, *Verify* (staff must confirm they checked the registry; they can correct details and, if the DNS record can't be added, vouch for the domain), *Reject*, *Suspend*, *Reinstate*.
- **Activity log** — staff sign-ins (and failures) and every verification request and decision.

Staff accounts are separate from company accounts (own table, cookie and signing key; a company login never works there). They're created **on the server only**:

```bash
npm run staff -- create --email you@yourcompany.com --name "Your Name"   # prints a temporary password
npm run staff -- reset --email ...       # forgot password / lost phone: new temporary password and authenticator
npm run staff -- disable --email ...     # signs them out everywhere
npm run staff -- list
```

On first sign-in at `/platform` they choose a new password (12+ characters) and set up an authenticator app (Google Authenticator, 1Password, …); every sign-in after that needs the password and a 6-digit code, and codes can't be reused. Sessions last 8 hours. Set `PLATFORM_ALLOWED_IPS` to only allow `/platform` from your office or VPN addresses.

The same actions are available from the server for scripting or emergencies (logged with the name given in `--by`):

```bash
npm run org -- list | show <company-id> | verify <company-id> --by "Name" [--trust-domain] | reject ... --reason "..." | suspend ... --reason "..."
```

## Roles

| Role | Can |
|---|---|
| **Issuer** | Create and edit their own drafts, submit for approval, start corrections |
| **Approver** | Everything an issuer can, plus approve/issue, send back, revoke |
| **Admin** | Everything, plus templates, people, company settings, activity log |

## PDF form templates

Dashboard → Templates → Add template → **Upload your PDF form**.

1. Upload a blank copy of the form (up to 15 MB, 30 pages). Password-protected PDFs are rejected. If the PDF has fillable fields, the editor offers to add them automatically.
2. **Drag a box** where a value should be printed and choose what goes there: a new field (text, long text, number, date, dropdown, tick box, image), a field that already exists, something filled in automatically (QR code, document number, verification code, issue date, company name/logo, prepared-by / approved-by name, qualification, signature, date), or a **table column**.
3. For tables, draw the box on the **first row** of each column. Set the row spacing and rows per page so the dashed guide boxes line up with the rows on the form. Extra rows continue on a copy of the page (header fields repeat).
4. Drag boxes to move them, drag the corner to resize, use arrow keys to nudge (Shift for bigger steps), Delete to remove.
5. Type an **example value** for a box (or use *Edit example values* for everything, including table rows). It shows in the box right away and in **Preview**. These are only for checking the layout; real values are entered on each document.
6. **Text style:** automatic size fills the box height (then shrinks to fit the width), so draw the box about the height of the text it replaces. Each box can set size, alignment, font (sans / serif / mono), bold and colour; new boxes take the colour of the text already printed there.
7. **Only have a filled-in copy of the form?** Upload it and draw boxes over the old information: new boxes erase what's under them by default (turn this off in the panel for blank forms). The cover colour is matched to the page automatically, and the erased area reaches slightly below the box to catch letter tails. On save, the editor makes a cleaned copy of the form: pages with erased areas are redrawn at 216 dpi with the old text removed (not just hidden), other pages stay as they are. The original upload is kept so you can change the erased areas later.

Drafts print "Awaiting approval" in the approver's name box. Drafts follow template changes: a draft moves to the latest template version when it is saved or submitted (documents awaiting approval or issued keep theirs). When an approver approves the document, their name, qualification, signature and the date are printed there.

How it stays secure:
- The uploaded form is stored under its SHA-256 fingerprint. The fingerprint and box layout are part of each template version's hash, which is signed into every issued document. If the stored form is swapped, rendering refuses.
- Issued PDFs are built from copies of the pages only: form fields are flattened and annotations, links and scripts are dropped, so nothing in the result is editable.
- Text is printed with the standard Helvetica font. Characters outside Western European (Latin-1) are replaced (e.g. ₦ becomes "N").
- Page rotation and crop boxes are handled, so scans saved sideways still line up.

`seeds/pressure-test/` has a sample form (`form.pdf`, regenerate with `node scripts/make-sample-form.js`) and its layout; `npm run seed:demo` creates it as a second demo template.

## Writing HTML templates

Layouts are HTML + [Handlebars](https://handlebarsjs.com/guide/). Each field key is a placeholder (`{{employerName}}`). Also available:

| Placeholder | What it is |
|---|---|
| `{{document.no}}`, `{{document.verificationCode}}` | Number and the human-readable code |
| `{{qr}}`, `{{verifyUrl}}` | QR image (data URL) and link — empty until issued |
| `{{org.name}}`, `{{org.logo}}` | Company name and logo |
| `{{preparedBy.name}}` `.qualification` `.signature` | Person who prepared it |
| `{{#if approvedBy}}…{{/if}}` | Approver (name, qualification, signature, date) — only once issued |
| `{{#each (chunk items 10)}}` | Split a table into pages of 10 rows |

Helpers: `formatDate`, `check`, `yesno`, `upper`, `default`, `inc`, `add`, `mul`, `length`, `eq`, `ne`, `and`, `or`, `not`.

Use inline CSS. When the PDF is made, the template can only load from the hosts in `RENDER_ALLOWED_HOSTS`; `file://`, `http://`, internal addresses and everything else are blocked. The demo template in `seeds/lifting-inspection/` is the original LOLER report converted to plain CSS (no Tailwind CDN, so rendering never depends on a third-party script).

## Moving over from the old version

Certificates already printed have QR codes pointing to `/report/<certificate number>`. To keep them working:

```bash
# 1. Sign up the company in the dashboard, note its ID (Settings → Signing key → Company ID),
#    and verify it at /platform (or: npm run org -- verify <company-id> --by "Your name" ...)
# 2. Import the rows from the old `certificates` table as signed, issued documents
PUBLIC_BASE_URL=https://your-domain npm run import:legacy -- --org <company-id> --dry-run
PUBLIC_BASE_URL=https://your-domain npm run import:legacy -- --org <company-id>
# 3. Set LEGACY_ORG_SLUG=<company-id> in .env and restart
```

Old QR links then redirect to the new verify page. (Legacy certificate numbers are guessable, so only imported documents are reachable that way; new documents use random codes.)

## Verification API

For partners who want to check documents automatically:

- `GET /api/public/verify/<code>` — verdict, status, checks, hashes, the signed payload and signature
- `GET /api/public/orgs/<company-id>/key` — the company's Ed25519 public key and verification status/details

The signature is Ed25519 over the canonical JSON (keys sorted, no whitespace) of `signedPayload`, so anyone can verify it independently with the public key.

## Tests and CI

```bash
npm run lint        # ESLint: real mistakes only (undefined names, unused code), not style
npm run test:unit   # fast, no database: crypto, TOTP codes, config checks, name/domain rules, schemas
npm run test:e2e    # end-to-end against real Postgres + headless Chrome (+ Redis if REDIS_URL is set)
npm test            # both
npm run db:check    # fails if src/entities changed without a migration
```

The end-to-end tests **wipe their database**, so they refuse to run unless its name contains "test" (`certificate_generator_test` by default; the Docker Compose Postgres creates it). Each file in `test/e2e/` starts from an empty database and they run one at a time:

| File | Covers |
|---|---|
| `auth` | sign-up, sign-in, invitations, temporary passwords, roles, sessions |
| `documents` | templates, the full lifecycle, background PDFs (pending, failure, retry), tampering with the database or the PDF file, corrections, revocation, old QR redirects, the activity log |
| `verification` | requesting verification, DNS proof, staff approval, name lock, impersonation attempts, unverified/suspended issuers |
| `platform` | staff accounts with authenticator codes, the review queue, verify/reject/suspend/reinstate, IP allow-list |
| `pdf-templates` | PDF form uploads, layout checks, printing onto pages, overflow pages, flattening, swapped forms |
| `security` | isolation between companies, templates that try to read files or internal services, sandboxed previews |
| `jobs`, `health` | the job queue (no double runs, retries, final failure), `/healthz`, `/readyz`, request IDs |
| `storage-s3` | the S3 driver against a real S3-compatible server (SeaweedFS), signed requests, PDFs and forms stored in the bucket, a replaced object detected. Runs when `S3_TEST_ENDPOINT` is set: `npm run s3:up`, then `S3_TEST_ENDPOINT=http://127.0.0.1:8333 npm run test:e2e`. Against a hosted store with an existing bucket (e.g. Neon), also set `S3_TEST_BUCKET`; the run uses a throwaway prefix and deletes what it wrote |

Shared set-up is in `test/helpers.js` (`createCompany`, `issueDocument`, `settle()` to run queued jobs, a fake DNS for domain checks).

GitHub Actions (`.github/workflows/ci.yml`) runs lint and unit tests, then the migration check and end-to-end tests against Postgres 16, Redis 7, SeaweedFS (S3) and headless Chrome, on every push and pull request.

To run the whole suite the way CI does:

```bash
npm run db:up && npm run redis:up && npm run s3:up
REDIS_URL=redis://127.0.0.1:6380 S3_TEST_ENDPOINT=http://127.0.0.1:8333 npm test
```

## Running in production

Processes, all from the same code:

| Process | Command | How many |
|---|---|---|
| Web server | `npm start` | one or more, behind a load balancer; each also runs a job worker unless `RUN_WORKER=false` |
| Job worker (optional) | `npm run worker` | to run PDF work on separate machines |
| Migrations | `npm run db:migrate` | once per deploy, before starting the new version (or `MIGRATE_ON_START=true` on a single server) |

For **more than one web server** you need shared state: `STORAGE_DRIVER=s3` (any S3-compatible store) and `REDIS_URL` (rate limits and previews). The job queue lives in Postgres, so workers on any number of machines share it safely.

**Health checks:** `/healthz` (the process is up; use for liveness) and `/readyz` (database, migrations, storage and Redis all work; returns 503 otherwise; use for readiness / load-balancer checks). `/readyz` also reports the job backlog (`checks.jobs`): a growing `oldestQueuedSeconds` means workers can't keep up.

**Logs and errors:** one JSON line per request with a request ID (also returned as the `X-Request-Id` header, and shown to users on unexpected errors so they can quote it). Set `SENTRY_DSN` to report unexpected errors and failed jobs to Sentry. Failed PDF jobs are retried with growing delays (5 attempts); after the last one the document shows "PDF failed" and approvers can retry it.

**Shutdown:** on SIGTERM the server stops taking requests, lets running jobs finish, then exits (within 25 seconds), so rolling deploys don't lose work. A job interrupted by a crash is picked up again after 10 minutes.

## Before going live

- Set a strong `APP_SECRET`, `NODE_ENV=production`, and an `https://` `PUBLIC_BASE_URL` (it's printed in every QR — don't change it later). The server refuses to start otherwise.
- Serve over HTTPS; set `TRUST_PROXY` behind a proxy.
- Back up the database **and** file storage together, and keep `APP_SECRET` somewhere safe — without it, signing keys can't be decrypted.
- Run `npm run db:migrate` as part of every deploy.
- Consider `ALLOW_SIGNUP=false` if you onboard companies yourself.
- Create your staff account (`npm run staff -- create ...`) and verify existing companies at `/platform`: they start as **not verified** after upgrading, so they can't issue until then, and documents they already issued show "Issuer not verified".
- Consider `PLATFORM_ALLOWED_IPS` so the staff dashboard is only reachable from your network.
- More than one server: `STORAGE_DRIVER=s3` and `REDIS_URL` (see above).
- Point your load balancer's health check at `/readyz`, and set `SENTRY_DSN`.

## Project layout

```
server.js / worker.js     web server (runs a job worker too) / standalone job worker
src/runtime.js            start-up checks and clean shutdown shared by both
src/config/               all settings (index.js) and the database connection
src/migrations/           database migrations (npm run db:migrate)
src/app.js                Express app: security headers, request logging, routes
src/entities/             database tables
src/lib/                  auth, signing/hashing, TOTP, field schema, template rendering, PDF overlay,
                          logger, error tracking, Redis, rate limits, migrations runner
src/services/             the rules: companies, people, templates, documents, jobs, storage, PDF, staff
src/routes/               thin HTTP layer: auth, dashboard API, staff API, public verify pages, health
public/assets/lib/        browser code shared by both dashboards (DOM helpers, API client, router)
public/assets/app/        company dashboard, one ES module per area (documents, templates, PDF editor, …)
public/assets/platform/   staff dashboard modules
seeds/                    demo templates (HTML and PDF form)
scripts/                  db migrations, demo seed, legacy import, staff and company-verification tools
test/unit/, test/e2e/     unit and end-to-end tests
```

Services never see Express objects: routes pass a small context (`{ user, ip, baseUrl }`, see `src/lib/context.js`), so scripts and the job worker call the same code. The browser code is plain ES modules with no build step; `npm run lint` checks imports between them.
