// `npm run dev`: the API (restarts on changes) and the dashboards' Vite dev
// server (hot reload) together. Open http://localhost:5173/app — API calls are
// proxied to the API on :3100, so it's same-origin as in production.
const { spawn } = require("node:child_process")

const colours = { api: "\x1b[36m", web: "\x1b[35m" }
const children = []
// The API gets its own port (a PORT set for the whole command is meant for the web server).
const API_PORT = process.env.API_PORT || "3100"

function run(name, args, env = {}) {
  const child = spawn("npm", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "1", ...env } })
  const prefix = `${colours[name]}[${name}]\x1b[0m `
  const forward = (stream, out) => {
    let buffer = ""
    stream.on("data", (chunk) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop()
      for (const line of lines) out.write(prefix + line + "\n")
    })
  }
  forward(child.stdout, process.stdout)
  forward(child.stderr, process.stderr)
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`)
    stop(code || 0)
  })
  children.push(child)
}

let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM")
  setTimeout(() => process.exit(code), 500)
}
process.on("SIGINT", () => stop(0))
process.on("SIGTERM", () => stop(0))

run("api", ["run", "dev", "-w", "@doctrust/api"], { PORT: API_PORT })
run("web", ["run", "dev", "-w", "@doctrust/web"], { API_URL: `http://127.0.0.1:${API_PORT}` })
console.log(`Dashboards: http://localhost:5173/app  ·  staff: http://localhost:5173/platform  ·  API: http://localhost:${API_PORT}`)
