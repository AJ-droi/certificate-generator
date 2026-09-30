// Lint rules: catch real mistakes (undefined names, unused code, unreachable
// branches), not style. Formatting is left as it is.
const js = require("@eslint/js")
const globals = require("globals")

const unused = ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }]

module.exports = [
  { ignores: ["node_modules/", "storage/", "coverage/", "public/vendor/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-unused-vars": unused, "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    // Browser code: the dashboards are ES modules, verify.js is a classic script.
    files: ["public/assets/**/*.js"],
    languageOptions: { sourceType: "module", globals: { ...globals.browser } },
  },
  {
    files: ["public/assets/verify.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { globals: { ...globals.node } },
  },
]
