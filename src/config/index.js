// Every setting read from the environment, in one place. Values are read when
// used (so tests can change them), and `assertConfig()` runs at start-up to
// refuse missing or unsafe settings instead of failing later.

const raw = (key) => {
  const v = process.env[key]
  return v === undefined || v === "" ? undefined : v
}
const str = (key, fallback) => raw(key) ?? fallback
const bool = (key, fallback) => (raw(key) === undefined ? fallback : String(raw(key)).toLowerCase() === "true")
const int = (key, fallback) => {
  const n = Number(raw(key))
  return raw(key) !== undefined && Number.isFinite(n) ? n : fallback
}
const list = (key, fallback = "") =>
  String(raw(key) ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

const DEFAULT_RENDER_HOSTS = "cdn.tailwindcss.com,fonts.googleapis.com,fonts.gstatic.com,cdn.jsdelivr.net,cdnjs.cloudflare.com"

const config = {
  get nodeEnv() { return str("NODE_ENV", "development") },
  get isProduction() { return this.nodeEnv === "production" },
  get isTest() { return this.nodeEnv === "test" },
  get port() { return int("PORT", 3100) },
  get appName() { return str("APP_NAME", "DocTrust") },
  // Encrypts company signing keys and signs sessions. Required, always.
  get appSecret() { return str("APP_SECRET", "") },
  // Printed in every QR code. Required in production.
  get publicBaseUrl() { return str("PUBLIC_BASE_URL", "").replace(/\/+$/, "") },
  get trustProxy() {
    const v = raw("TRUST_PROXY")
    if (v === undefined) return false
    return v === "true" ? true : /^\d+$/.test(v) ? Number(v) : v
  },
  get allowSignup() { return bool("ALLOW_SIGNUP", true) },
  get renderAllowedHosts() { return list("RENDER_ALLOWED_HOSTS", DEFAULT_RENDER_HOSTS).map((h) => h.toLowerCase()) },
  get legacyOrgSlug() { return str("LEGACY_ORG_SLUG", "") },
  get platformAllowedIps() { return list("PLATFORM_ALLOWED_IPS") },
  get rateLimits() {
    return { auth: int("AUTH_RATE_LIMIT", 20), verify: int("VERIFY_RATE_LIMIT", 60), platformAuth: int("PLATFORM_AUTH_RATE_LIMIT", 10) }
  },

  get database() {
    return {
      url: str("DATABASE_URL", ""),
      host: str("PGHOST", "127.0.0.1"),
      port: int("PGPORT", 5432),
      user: str("PGUSER", "postgres"),
      password: str("PGPASSWORD", ""),
      name: str("PGDATABASE", "certificate_generator"),
      ssl: bool("PGSSL", false),
      poolSize: int("PG_POOL_SIZE", 10),
    }
  },

  // "local" keeps files in STORAGE_DIR (one server only); "s3" uses any
  // S3-compatible store (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO).
  get storage() {
    return {
      driver: str("STORAGE_DRIVER", "local"),
      dir: str("STORAGE_DIR", "./storage"),
      s3: {
        bucket: str("S3_BUCKET", ""),
        region: str("S3_REGION", "us-east-1"),
        endpoint: str("S3_ENDPOINT", ""),
        accessKeyId: str("S3_ACCESS_KEY_ID", ""),
        secretAccessKey: str("S3_SECRET_ACCESS_KEY", ""),
        forcePathStyle: bool("S3_FORCE_PATH_STYLE", false),
        prefix: str("S3_PREFIX", "").replace(/^\/+|\/+$/g, ""),
      },
    }
  },

  // Shared state for more than one server: rate limits and dashboard previews.
  // Without it both are kept in this process's memory.
  get redisUrl() { return str("REDIS_URL", "") },

  get logLevel() { return str("LOG_LEVEL", this.isTest ? "silent" : "info") },
  get sentryDsn() { return str("SENTRY_DSN", "") },

  get render() {
    return {
      // Chrome pages open at once in this process (previews, PDFs, images).
      concurrency: Math.max(1, int("RENDER_CONCURRENCY", 2)),
      executablePath: str("PUPPETEER_EXECUTABLE_PATH", undefined),
      noSandbox: bool("PUPPETEER_NO_SANDBOX", false),
    }
  },

  // Background jobs (making official PDFs). Every server runs a worker unless
  // RUN_WORKER=false, e.g. when workers run separately (npm run worker).
  // Run pending migrations when a server starts (otherwise it refuses to start
  // until `npm run db:migrate` has run). Handy for single-server deploys.
  get migrateOnStart() { return bool("MIGRATE_ON_START", false) },

  get worker() {
    return {
      enabled: bool("RUN_WORKER", true),
      concurrency: Math.max(1, int("WORKER_CONCURRENCY", 2)),
      pollMs: Math.max(50, int("WORKER_POLL_MS", 1000)),
    }
  },
}

const WEAK_SECRET = /change-?me|dev-only|example|secret|password|^(.)\1+$/i

// Throws one error listing everything that's wrong.
function assertConfig() {
  const problems = []
  const secret = config.appSecret
  if (secret.length < 32) {
    problems.push("APP_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48")
  } else if (config.isProduction && WEAK_SECRET.test(secret)) {
    problems.push("APP_SECRET looks like a placeholder. Generate a random one with: openssl rand -base64 48")
  }
  if (config.isProduction) {
    const url = config.publicBaseUrl
    if (!/^https:\/\/[^/]+/.test(url)) problems.push("PUBLIC_BASE_URL must be set to the https:// address partners scan (it's printed in every QR code)")
  }
  const { driver, s3 } = config.storage
  if (!["local", "s3"].includes(driver)) problems.push(`STORAGE_DRIVER must be "local" or "s3" (got "${driver}")`)
  if (driver === "s3") {
    if (!s3.bucket) problems.push("S3_BUCKET is required when STORAGE_DRIVER=s3")
    if (Boolean(s3.accessKeyId) !== Boolean(s3.secretAccessKey)) problems.push("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (to use the machine's IAM role)")
  }
  if (config.redisUrl && !/^rediss?:\/\//.test(config.redisUrl)) problems.push("REDIS_URL must start with redis:// or rediss://")
  if (problems.length) {
    const err = new Error(`Configuration problems:\n  - ${problems.join("\n  - ")}`)
    err.code = "CONFIG_INVALID"
    throw err
  }
}

module.exports = { config, assertConfig }
