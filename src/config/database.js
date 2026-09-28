const { DataSource } = require("typeorm")
const entities = require("../entities")

const useSsl = String(process.env.PGSSL || "").toLowerCase() === "true"

const baseOptions = process.env.DATABASE_URL
  ? { type: "postgres", url: process.env.DATABASE_URL }
  : {
      type: "postgres",
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      username: process.env.PGUSER || "postgres",
      password: process.env.PGPASSWORD || "",
      database: process.env.PGDATABASE || "certificate_generator",
    }

const AppDataSource = new DataSource({
  ...baseOptions,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  logging: false,
  // Auto-creates tables. Fine for getting started; switch to migrations before
  // real production data (set DB_SYNC=false).
  synchronize: String(process.env.DB_SYNC || "true").toLowerCase() !== "false",
  entities: Object.values(entities),
})

async function initializeDatabase() {
  if (!AppDataSource.isInitialized) await AppDataSource.initialize()
  return AppDataSource
}

const repo = (name) => AppDataSource.getRepository(name)

module.exports = { AppDataSource, initializeDatabase, repo }
