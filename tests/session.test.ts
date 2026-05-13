/**
 * tests/session.test.ts — Session health check and login state management tests
 *
 * Key bug this prevents: Upwork shows "Sign up" (not "Log in") when signed out.
 * The old code only checked for "Log in", so it thought we were logged in when we weren't.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock browser engine
vi.mock("../src/browser/engine", () => ({
  newPage: vi.fn(),
  humanDelay: vi.fn().mockResolvedValue(undefined),
  waitForCloudflare: vi.fn().mockResolvedValue(true),
  launch: vi.fn(),
  saveCookies: vi.fn().mockResolvedValue(undefined),
  restoreCookies: vi.fn().mockResolvedValue(false),
  hasSavedCookies: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/config/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/Agent", () => ({
  answerScreeningQuestion: vi.fn(),
}));

import { invalidateSession, checkSessionHealth } from "../src/browser/upwork";
import { launch } from "../src/browser/engine";

// Helper — builds a mock page with evaluate returning the given check state
function mockPageWithState(state: {
  url?: string;
  hasLoginLink?: boolean;
  hasSignupLink?: boolean;
  hasLoginText?: boolean;
  hasSignupText?: boolean;
  hasAvatar?: boolean;
  hasNavMenu?: boolean;
  isOnLoginPage?: boolean;
  isOnCF?: boolean;
  title?: string;
}, extraOverrides?: { goto?: unknown; $?: unknown }) {
  const url = state.url || "https://www.upwork.com/";
  return {
    url: vi.fn().mockReturnValue(url),
    evaluate: vi.fn().mockResolvedValue({
      url,
      hasLoginLink: state.hasLoginLink ?? false,
      hasSignupLink: state.hasSignupLink ?? false,
      hasLoginText: state.hasLoginText ?? false,
      hasSignupText: state.hasSignupText ?? false,
      hasAvatar: state.hasAvatar ?? false,
      hasNavMenu: state.hasNavMenu ?? false,
      isOnLoginPage: state.isOnLoginPage ?? false,
      isOnCF: state.isOnCF ?? false,
      title: state.title || "Upwork",
    }),
    $: extraOverrides?.$ || vi.fn().mockResolvedValue(null),
    goto: extraOverrides?.goto || vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(state.title || "Upwork"),
    createCDPSession: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

function mockLaunchWith(page: unknown) {
  vi.mocked(launch).mockResolvedValue({
    pages: vi.fn().mockResolvedValue([page]),
  } as any);
}

describe("Session Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSession();
  });

  // ── invalidateSession ──

  describe("invalidateSession", () => {
    it("should reset session state without throwing", () => {
      expect(() => invalidateSession()).not.toThrow();
    });

    it("should be callable multiple times safely", () => {
      invalidateSession();
      invalidateSession();
      invalidateSession();
    });
  });

  // ── Signed-in detection ──

  describe("signed-in detection", () => {
    it("should report valid when avatar is present", async () => {
      mockLaunchWith(mockPageWithState({ hasAvatar: true, hasNavMenu: true }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(true);
      expect(result.detail).toContain("valid");
    });

    it("should report valid when user nav menu is present (no avatar)", async () => {
      mockLaunchWith(mockPageWithState({ hasAvatar: false, hasNavMenu: true }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(true);
    });

    it("should report valid when avatar is present even if signup link exists", async () => {
      // Edge case: page has avatar AND a stale signup link in footer
      mockLaunchWith(mockPageWithState({ hasAvatar: true, hasSignupLink: true }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(true);
    });
  });

  // ── Signed-out detection (THE BUG) ──

  describe("signed-out detection — Sign up indicator", () => {
    it("should detect signed out when only 'Sign up' link is present (the actual Upwork bug)", async () => {
      // This is the exact scenario that was broken: Upwork shows "Sign up" not "Log in"
      mockLaunchWith(mockPageWithState({
        hasSignupLink: true,
        hasSignupText: true,
        hasLoginLink: false,
        hasLoginText: false,
        hasAvatar: false,
        hasNavMenu: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Signed out");
      expect(result.detail).toContain("signup=true");
    });

    it("should detect signed out when 'Sign up' text but no signup link", async () => {
      mockLaunchWith(mockPageWithState({
        hasSignupText: true,
        hasSignupLink: false,
        hasAvatar: false,
        hasNavMenu: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
    });

    it("should detect signed out when both signup and login are present", async () => {
      mockLaunchWith(mockPageWithState({
        hasSignupLink: true,
        hasLoginLink: true,
        hasSignupText: true,
        hasLoginText: true,
        hasAvatar: false,
        hasNavMenu: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
    });
  });

  // ── Signed-out detection — Log in indicator ──

  describe("signed-out detection — Log in indicator", () => {
    it("should detect signed out when only 'Log in' link is present", async () => {
      mockLaunchWith(mockPageWithState({
        hasLoginLink: true,
        hasLoginText: true,
        hasSignupLink: false,
        hasAvatar: false,
        hasNavMenu: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Signed out");
    });

    it("should detect signed out on explicit login page URL", async () => {
      mockLaunchWith(mockPageWithState({
        url: "https://www.upwork.com/ab/account-security/login",
        isOnLoginPage: true,
        hasLoginLink: true,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("login page");
    });
  });

  // ── Cloudflare ──

  describe("Cloudflare detection", () => {
    it("should report invalid when Cloudflare is blocking", async () => {
      mockLaunchWith(mockPageWithState({
        isOnCF: true,
        title: "Just a moment...",
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Cloudflare");
    });

    it("should detect Cloudflare 'Checking' page", async () => {
      mockLaunchWith(mockPageWithState({
        isOnCF: true,
        title: "Checking your browser",
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
    });
  });

  // ── Ambiguous state / navigation fallback ──

  describe("ambiguous state — navigation check fallback", () => {
    it("should navigate to verify when no clear indicators exist", async () => {
      const mockGoto = vi.fn().mockResolvedValue(undefined);
      const page = mockPageWithState(
        { hasAvatar: false, hasNavMenu: false, hasSignupLink: false, hasLoginLink: false },
        { goto: mockGoto, $: vi.fn().mockResolvedValue({ tagName: "img" }) },
      );
      mockLaunchWith(page);

      const result = await checkSessionHealth();
      expect(mockGoto).toHaveBeenCalledWith(
        "https://www.upwork.com/nx/find-work/",
        expect.any(Object),
      );
      expect(result.valid).toBe(true);
    });

    it("should detect login redirect during navigation check", async () => {
      const page = {
        url: vi.fn()
          .mockReturnValueOnce("https://www.upwork.com/")
          .mockReturnValueOnce("https://www.upwork.com/")
          .mockReturnValue("https://www.upwork.com/ab/account-security/login"),
        evaluate: vi.fn().mockResolvedValue({
          url: "https://www.upwork.com/",
          hasLoginLink: false,
          hasSignupLink: false,
          hasLoginText: false,
          hasSignupText: false,
          hasAvatar: false,
          hasNavMenu: false,
          isOnLoginPage: false,
          isOnCF: false,
          title: "Upwork",
        }),
        goto: vi.fn().mockResolvedValue(undefined),
        $: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue("Log In"),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
      };
      mockLaunchWith(page);

      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Redirected to login");
    });

    it("should report invalid when avatar not found after navigation", async () => {
      const page = mockPageWithState(
        { hasAvatar: false, hasNavMenu: false, hasSignupLink: false, hasLoginLink: false },
        { goto: vi.fn().mockResolvedValue(undefined), $: vi.fn().mockResolvedValue(null) },
      );
      mockLaunchWith(page);

      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("No clear login indicators");
    });
  });

  // ── Error handling ──

  describe("error handling", () => {
    it("should handle page evaluation returning null", async () => {
      const page = {
        url: vi.fn().mockReturnValue("https://www.upwork.com/"),
        evaluate: vi.fn().mockResolvedValue(null),
        $: vi.fn().mockResolvedValue(null),
        goto: vi.fn().mockResolvedValue(undefined),
        title: vi.fn().mockResolvedValue("Upwork"),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
      };
      mockLaunchWith(page);
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Could not evaluate");
    });

    it("should handle no browser pages available", async () => {
      vi.mocked(launch).mockResolvedValue({
        pages: vi.fn().mockResolvedValue([]),
      } as any);
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("No browser page");
    });

    it("should handle CDP launch failure", async () => {
      vi.mocked(launch).mockRejectedValue(new Error("CDP connection refused"));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("Session check error");
      expect(result.detail).toContain("CDP connection refused");
    });

    it("should handle evaluate throwing", async () => {
      const page = {
        url: vi.fn().mockReturnValue("https://www.upwork.com/"),
        evaluate: vi.fn().mockRejectedValue(new Error("Execution context destroyed")),
        $: vi.fn().mockResolvedValue(null),
        goto: vi.fn().mockResolvedValue(undefined),
        title: vi.fn().mockResolvedValue("Upwork"),
        createCDPSession: vi.fn().mockResolvedValue({
          send: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn().mockResolvedValue(undefined),
        }),
      };
      mockLaunchWith(page);
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
    });
  });

  // ── Real-world regression scenarios ──

  describe("real-world regression scenarios", () => {
    it("Upwork search page while signed out (the original bug)", async () => {
      // Exact state we observed: page title says "Search Freelance Jobs" but nav shows "Sign up"
      mockLaunchWith(mockPageWithState({
        url: "https://www.upwork.com/nx/search/jobs/?q=AI%20automation",
        title: "Search Freelance Jobs on Upwork",
        hasSignupLink: true,
        hasSignupText: true,
        hasLoginLink: false,
        hasLoginText: false,
        hasAvatar: false,
        hasNavMenu: false,
        isOnLoginPage: false,
        isOnCF: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
      expect(result.detail).toContain("signup=true");
    });

    it("Upwork search page while signed in", async () => {
      mockLaunchWith(mockPageWithState({
        url: "https://www.upwork.com/nx/search/jobs/?q=AI%20automation",
        title: "Search Freelance Jobs on Upwork",
        hasSignupLink: false,
        hasSignupText: false,
        hasAvatar: true,
        hasNavMenu: true,
        isOnLoginPage: false,
        isOnCF: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(true);
    });

    it("Cloudflare verify page after session timeout", async () => {
      mockLaunchWith(mockPageWithState({
        url: "https://www.upwork.com/",
        title: "Just a moment...",
        isOnCF: true,
        hasAvatar: false,
        hasNavMenu: false,
      }));
      const result = await checkSessionHealth();
      expect(result.valid).toBe(false);
    });

    it("Upwork homepage with only hamburger menu (mobile-like view)", async () => {
      // No avatar, no signup, no login — SPA hasn't fully loaded
      const mockGoto = vi.fn().mockResolvedValue(undefined);
      mockLaunchWith(mockPageWithState(
        {
          hasAvatar: false,
          hasNavMenu: false,
          hasSignupLink: false,
          hasLoginLink: false,
        },
        { goto: mockGoto, $: vi.fn().mockResolvedValue(null) },
      ));
      const result = await checkSessionHealth();
      // Should fall through to navigation check since state is ambiguous
      expect(mockGoto).toHaveBeenCalled();
    });
  });
});
