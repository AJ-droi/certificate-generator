# Certificate Generator → document verification platform

Companies upload their certificate/report templates, issue documents with a QR code, and partners scan the code to confirm a document is genuine, unaltered and still valid.

## How it works

1. **A company signs up.** It gets its own users, templates, documents and an Ed25519 signing key. The private key is encrypted with `APP_SECRET` and never leaves the server.
2. **An admin adds a template**, in one of two ways:
   - **Upload the company's PDF form (recommended).** Draw a box on the page wherever information goes and say what it is; that creates the input field. Place the QR code, signatures and document number the same way. The design stays exactly as it is — data is printed onto the original pages.
   - **Write an HTML layout** with Handlebars placeholders, for developers or documents with long variable tables.

   Saving changes creates a new version; documents keep the version they were made with.
3. **An issuer fills in the form** generated from the fields — including tables, which can be pasted from Excel — and submits it.
4. **An approver issues it.** A different person must approve (can be turned off per company). On issue the document is locked, the content is signed, the approver's name/signature is added, and the official PDF is generated with a QR code pointing to `/v/<code>`.
5. **A partner scans the QR code** and sees:
   - **Valid** — issued by the company and unchanged since signing
   - **Revoked** — with the reason the company gave
   - **Superseded** — with a link to the corrected version
   - **Failed integrity check** — the stored record no longer matches its signature
   
   They can view the full document, download the official PDF, or pick the PDF they were sent to check it byte-for-byte (in their browser, no upload).

Mistakes in an issued document are fixed with a **correction**: a new draft (`…-R1`) that, once issued, marks the original as superseded. Every action is recorded in the activity log.

### Why the QR can't just be copied onto a fake

The verify page shows the real contents of the document. A forger who copies a genuine QR onto an edited certificate sends the partner to a page showing the *original* details, which won't match. Verification codes are 120-bit random values, so they can't be guessed or enumerated.

## Quick start

Requires Node 22.9+ and PostgreSQL.

```bash
npm install
cp .env.example .env          # set APP_SECRET, PUBLIC_BASE_URL and database settings
createdb certificate_generator
npm run seed:demo             # optional: demo company, 3 users, sample certificate
npm start                     # http://localhost:3100
```

- Dashboard: `http://localhost:3100/app`
- Verify page: `http://localhost:3100/` (enter a code) or scan a QR
- Demo logins (password `demo-password-123`): `admin@demo.test`, `inspector@demo.test` (issuer), `approver@demo.test`

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
# 1. Sign up the company in the dashboard, note its ID (Settings → Signing key → Company ID)
# 2. Import the rows from the old `certificates` table as signed, issued documents
PUBLIC_BASE_URL=https://your-domain npm run import:legacy -- --org <company-id> --dry-run
PUBLIC_BASE_URL=https://your-domain npm run import:legacy -- --org <company-id>
# 3. Set LEGACY_ORG_SLUG=<company-id> in .env and restart
```

Old QR links then redirect to the new verify page. (Legacy certificate numbers are guessable, so only imported documents are reachable that way; new documents use random codes.)

## Verification API

For partners who want to check documents automatically:

- `GET /api/public/verify/<code>` — verdict, status, checks, hashes, the signed payload and signature
- `GET /api/public/orgs/<company-id>/key` — the company's Ed25519 public key

The signature is Ed25519 over the canonical JSON (keys sorted, no whitespace) of `signedPayload`, so anyone can verify it independently with the public key.

## Tests

The tests use a real database and **wipe it**, so they refuse to run unless the database name contains "test":

```bash
createdb certificate_generator_test
PGDATABASE=certificate_generator_test npm test
```

They cover the full lifecycle, PDF form templates (upload checks, fillable-field detection, overflow pages, flattening, swapped forms), four-eyes approval, tampering with the database and the PDF file, corrections, revocation, isolation between companies, blocking templates from reading server files or internal services, and old QR redirects.

## Before going live

- Set a strong `APP_SECRET`, `NODE_ENV=production`, and `PUBLIC_BASE_URL` (it's printed in every QR — don't change it later).
- Serve over HTTPS; set `TRUST_PROXY` behind a proxy.
- Back up the database **and** `STORAGE_DIR` together, and keep `APP_SECRET` somewhere safe — without it, signing keys can't be decrypted.
- Switch `DB_SYNC=false` and use migrations once you have real data.
- Consider `ALLOW_SIGNUP=false` if you onboard companies yourself.
- Previews are cached in memory; if you run more than one server instance, move that cache to Redis.

## Project layout

```
server.js                 start-up
src/app.js                Express app, security headers
src/entities/             database tables
src/lib/                  auth, signing/hashing, field schema, template rendering,
                          pdf-overlay.js (PDF form templates: inspect, validate, print onto pages)
src/services/             templates, documents (issue/revoke/correct/verify), PDF, storage
src/routes/               auth, dashboard API, public verify pages
public/                   dashboard (app.html + assets)
seeds/lifting-inspection/ the original LOLER certificate as an HTML template
seeds/pressure-test/      a sample PDF form with its field layout
scripts/                  demo seed, legacy import
test/                     end-to-end tests
```
