// Builds the two dashboards: /app (companies) and /platform (staff).
// Production: the API serves dist/ (pages at /app and /platform, files under /web/).
// Development: `npm run dev` here, with API calls proxied to the API server, so
// everything is same-origin exactly as in production.
import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"

const API = process.env.API_URL || "http://127.0.0.1:3100"

// Every path under /app or /platform is a client-side route: serve its page.
function dashboardPages(): Plugin {
  return {
    name: "doctrust-dashboard-pages",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || ""
        if (/^\/app(\/|\?|$)/.test(url)) req.url = "/web/app.html"
        else if (/^\/platform(\/|\?|$)/.test(url)) req.url = "/web/platform.html"
        next()
      })
    },
  }
}

// Everything the API serves itself (JSON API, verify pages, previews, pdf.js files…).
const API_PATHS = ["^/$", "/api", "/v/", "/verify", "/render", "/report", "/vendor", "/assets", "/images", "/healthz", "/readyz"]

export default defineConfig({
  base: "/web/",
  plugins: [react(), dashboardPages()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: { input: { app: "app.html", platform: "platform.html" } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(API_PATHS.map((p) => [p, { target: API }])),
  },
})
