import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

// Load .env so live tests (LIVE_TESTS=1) can reach Supabase / Anthropic without re-exporting.
// Mocked tests don't read these vars, so this is harmless when LIVE_TESTS is unset.
dotenv.config();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});
