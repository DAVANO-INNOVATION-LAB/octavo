import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The collaboration server runs outside the bundle and is loaded by
    // Next's own CommonJS entry, so it is CommonJS on purpose.
    "server/**",
    // Vendored third-party assets: minified, not ours to fix, and large
    // enough that parsing them exhausts the linter's heap.
    "public/drawio/**",
    "public/**/*.min.js",
  ]),
]);

export default eslintConfig;
