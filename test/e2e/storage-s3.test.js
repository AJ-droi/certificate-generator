// File storage on an S3-compatible store: the real driver against a real server.
// Runs when S3_TEST_ENDPOINT is set, e.g. with the Docker Compose SeaweedFS:
//   npm run s3:up
//   S3_TEST_ENDPOINT=http://127.0.0.1:8333 npm run test:e2e
// (Keys default to those in docker/seaweedfs-s3.json; override with S3_TEST_ACCESS_KEY_ID / S3_TEST_SECRET_ACCESS_KEY.)
//
// Against a hosted store with an existing bucket (e.g. Neon Object Storage), set
// S3_TEST_BUCKET. The AWS_* settings from .env are used when S3_TEST_ENDPOINT matches
// AWS_ENDPOINT_URL_S3. Everything is written under a throwaway prefix and deleted after.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")

const endpoint = process.env.S3_TEST_ENDPOINT
if (!endpoint) {
  test("S3 storage (set S3_TEST_ENDPOINT to run)", { skip: "S3_TEST_ENDPOINT not set" }, () => {})
} else {
  const hosted = endpoint === process.env.AWS_ENDPOINT_URL_S3
  const existingBucket = process.env.S3_TEST_BUCKET
  const bucket = existingBucket || `cg-test-${crypto.randomBytes(4).toString("hex")}`
  const prefix = `cg-test-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  Object.assign(process.env, {
    STORAGE_DRIVER: "s3",
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: process.env.S3_TEST_REGION || (hosted && process.env.AWS_REGION) || "us-east-1",
    S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY_ID || (hosted && process.env.AWS_ACCESS_KEY_ID) || "local-access-key",
    S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_ACCESS_KEY || (hosted && process.env.AWS_SECRET_ACCESS_KEY) || "local-secret-key",
    S3_FORCE_PATH_STYLE: "true",
    S3_PREFIX: prefix,
  })
  const h = require("../helpers")
  const storage = require("../../src/services/storage.service")
  const { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3")
  const { makeSampleForm } = require("../../scripts/make-sample-form")

  const s3 = new S3Client({
    region: process.env.S3_REGION,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  })
  const getObject = async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToByteArray())
  const anon = h.client()
  let acme

  // Deletes everything this run wrote (only under its own prefix).
  async function cleanUp() {
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }))
      const keys = (page.Contents || []).map((o) => ({ Key: o.Key }))
      if (!keys.length) return
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }))
    }
  }

  before(async () => {
    if (!existingBucket) await s3.send(new CreateBucketCommand({ Bucket: bucket }))
    await h.startApp()
    acme = await h.createCompany({ name: "Acme Inspections", domain: "acme.test" })
  })
  after(async () => {
    await cleanUp()
    await h.stopApp()
  })

  test("the S3 driver stores, reads and checks files (under the configured prefix)", async () => {
    const orgId = crypto.randomUUID()
    const docId = crypto.randomUUID()
    const bytes = Buffer.from("%PDF-1.7 test file")
    const key = await storage.savePdf(orgId, docId, bytes)
    assert.equal(key, `pdf/${orgId}/${docId}.pdf`)
    assert.deepEqual(await storage.readFile(key), bytes)
    assert.deepEqual(await getObject(`${prefix}/${key}`), bytes, "stored under S3_PREFIX")
    await assert.rejects(storage.readFile(`pdf/${orgId}/${crypto.randomUUID()}.pdf`), (err) => err.code === "ENOENT")
    await assert.rejects(storage.readFile("../../etc/passwd"), /Invalid storage key/)

    // Uploaded forms are stored by fingerprint and never overwritten.
    const hash = "a".repeat(64)
    await storage.saveTemplateSource(orgId, hash, Buffer.from("first"))
    await storage.saveTemplateSource(orgId, hash, Buffer.from("second"))
    assert.equal(String(await storage.readTemplateSource(orgId, hash)), "first")
    assert.equal(await storage.hasTemplateSource(orgId, hash), true)
    assert.equal(await storage.hasTemplateSource(orgId, "b".repeat(64)), false)
  })

  test("/readyz checks the bucket", async () => {
    const r = await anon("GET", "/readyz")
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.checks.storage.driver, "s3")
    const good = process.env.S3_SECRET_ACCESS_KEY
    process.env.S3_SECRET_ACCESS_KEY = "wrong-secret"
    try {
      const bad = await anon("GET", "/readyz")
      assert.equal(bad.status, 503, "wrong credentials must fail the readiness check")
      assert.equal(bad.data.checks.storage.ok, false)
    } finally {
      process.env.S3_SECRET_ACCESS_KEY = good
    }
    assert.equal((await anon("GET", "/readyz")).status, 200)
  })

  test("issuing stores the official PDF in S3, and a replaced object is detected", async () => {
    const t = await acme.admin("POST", "/api/templates", { name: "Report", html: h.HTML, schema: h.SCHEMA })
    const doc = await h.issueDocument(acme, t.data.template.id)
    await h.settle()
    const [row] = await h.db.query("SELECT pdf_path, pdf_hash, pdf_status FROM documents WHERE id = $1", [doc.id])
    assert.equal(row.pdf_status, "ready")
    const stored = await getObject(`${prefix}/${row.pdf_path}`)
    assert.equal(crypto.createHash("sha256").update(stored).digest("hex"), row.pdf_hash)
    const downloaded = await acme.issuer("GET", `/api/documents/${doc.id}/pdf`)
    assert.deepEqual(downloaded.data, stored)
    assert.deepEqual((await anon("GET", `/v/${doc.publicId}/pdf`)).data, stored)
    assert.equal((await anon("GET", `/api/public/verify/${doc.publicId}`)).data.checks.pdfMatches, true)

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${row.pdf_path}`, Body: Buffer.concat([stored, Buffer.from("%x")]) }))
    const v = await anon("GET", `/api/public/verify/${doc.publicId}`)
    assert.equal(v.data.checks.pdfMatches, false)
    assert.equal(v.data.verdict, "tampered")
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${row.pdf_path}`, Body: stored }))
    assert.equal((await anon("GET", `/api/public/verify/${doc.publicId}`)).data.verdict, "valid")
  })

  test("uploaded PDF forms are stored in S3 and PDF templates print onto them", async () => {
    const up = await h.uploadPdf(acme.admin, await makeSampleForm())
    assert.equal(up.status, 201, JSON.stringify(up.data))
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/templates/` }))
    assert.ok(listed.Contents.some((o) => o.Key.endsWith(`${up.data.sourceHash}.pdf`)))
    const back = await acme.admin("GET", `/api/templates/pdf-source/${up.data.sourceHash}`)
    assert.equal(back.status, 200)
    assert.equal(crypto.createHash("sha256").update(back.data).digest("hex"), up.data.sourceHash)

    const schema = [{ key: "client", label: "Client", type: "text" }]
    const t = await acme.admin("POST", "/api/templates", {
      name: "Form", kind: "pdf", sourceHash: up.data.sourceHash, schema,
      layout: { items: [{ kind: "field", key: "client", page: 0, x: 380, y: 125, w: 185, h: 13 }] },
    })
    assert.equal(t.status, 201, JSON.stringify(t.data))
    const doc = await h.issueDocument(acme, t.data.template.id, { client: "Stored In S3 Ltd" })
    await h.settle()
    const pdf = await acme.issuer("GET", `/api/documents/${doc.id}/pdf`)
    assert.equal(pdf.status, 200)
    assert.match((await h.pdfText(pdf.data)).join(" "), /Stored In S3 Ltd/)
  })
}
