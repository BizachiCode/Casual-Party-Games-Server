// Lint: typescript-eslint's recommended rules, with Prettier owning the layout (npm run format).
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["build/", "node_modules/", "data/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node, ...globals.mocha } },
    rules: {
      // Names say what they hold. Allowed short names: loop indices, coordinates and the Schema builder `t`.
      "id-length": ["error", { min: 2, exceptions: ["i", "j", "x", "y", "z", "t", "_"], properties: "never" }],
      // One declaration per statement, so Prettier gives each its own line.
      "one-var": ["error", "never"],
      // Prettier wraps code at 120 columns; this also holds comments, strings and test titles to it.
      "max-len": ["error", { code: 120, ignoreUrls: true, ignoreRegExpLiterals: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
    },
  },
);
