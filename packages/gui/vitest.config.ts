import { configDefaults, defineConfig } from "vitest/config";
import { DOM_FREE_TESTS } from "./vitest.dom-free.js";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/setup-tests.ts"],
    globals: false,
    include: ["src/renderer/**/*.test.{ts,tsx}", "src/main/**/*.test.{ts,tsx}"],
    // The dom-free files run in the root config's `gui-node` project instead
    // (node environment, no setup file). Excluded from the SAME array they are
    // included by, so the two projects can never overlap or leave a gap —
    // `src/vitest-dom-free.test.ts` guards both directions.
    exclude: [...configDefaults.exclude, ...DOM_FREE_TESTS],
  },
});
