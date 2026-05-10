import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertRequiredEnv } from "../src/secret";

const REQUIRED_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "NODE_ENV",
];

describe("assertRequiredEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of REQUIRED_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of REQUIRED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is a no-op outside production", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it("throws when force=true and required vars are missing", () => {
    for (const k of REQUIRED_KEYS) delete process.env[k];
    expect(() => assertRequiredEnv({ force: true })).toThrow(/Missing required env vars/);
  });

  it("does not throw when force=true and all required vars are present", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.SUPABASE_URL = "x";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.TELEGRAM_CHAT_ID = "x";
    expect(() => assertRequiredEnv({ force: true })).not.toThrow();
  });
});
