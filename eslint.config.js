// Lint rules: catch real mistakes (undefined names, unused code, unreachable
// branches), not style. Formatting is left as it is.
const js = require("@eslint/js")
const globals = require("globals")
const tseslint = require("typescript-eslint")
const reactHooks = require("eslint-plugin-react-hooks")

const unused = ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }]

module.exports = [
  { ignores: ["**/node_modules/", "**/storage/", "coverage/", "**/dist/", "playwright-report/", "test-results/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-unused-vars": unused, "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    // The verify page's script (a classic browser script).
    files: ["apps/api/public/assets/verify.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
  },
  // The React app (TypeScript).
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["apps/web/**/*.{ts,tsx}", "packages/shared/**/*.ts"] })),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
]
