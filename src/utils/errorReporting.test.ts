import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getUserFriendlyMessage,
  reportError,
  ErrorSeverity,
  configureErrorReporting,
  withErrorHandling,
  withSyncErrorHandling,
  errorStats,
  reportErrorWithStats,
} from "./errorReporting";

describe("errorReporting", () => {
  beforeEach(() => {
    // Reset configuration
    configureErrorReporting({
      logToConsole: false,
      reportToBackend: false,
      showUserFriendlyMessages: true,
    });
    errorStats.clear();
  });

  describe("getUserFriendlyMessage", () => {
    it("should handle network errors", () => {
      const error = new Error("fetch failed: network error");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("connect");
      expect(message).toContain("internet");
    });

    it("should handle permission errors", () => {
      const error = new Error("permission denied");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("Permission");
      expect(message).toContain("access");
    });

    it("should handle timeout errors", () => {
      const error = new Error("operation timeout");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("too long");
    });

    it("should handle file not found errors", () => {
      const error = new Error("ENOENT: file not found");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("file");
      expect(message).toContain("not be found");
    });

    it("should handle PTY errors", () => {
      const error = new Error("failed to spawn PTY");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("terminal");
    });

    it("should handle database errors", () => {
      const error = new Error("database query failed");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("storage");
    });

    it("should handle MCP server errors", () => {
      const error = new Error("MCP server connection failed");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("AI service");
    });

    it("should provide generic fallback for unknown errors", () => {
      const error = new Error("something went wrong");
      const message = getUserFriendlyMessage(error);
      expect(message).toContain("unexpected error");
    });
  });

  describe("reportError", () => {
    it("should create a reported error with user-friendly message", () => {
      const error = new Error("fetch failed");
      const reported = reportError(error);

      expect(reported.message).toBe("fetch failed");
      expect(reported.userMessage).toContain("connect");
      expect(reported.timestamp).toBeDefined();
    });

    it("should include context in the reported error", () => {
      const error = new Error("test error");
      const context = { component: "TestComponent", action: "testAction" };
      const reported = reportError(error, context);

      expect(reported.context.component).toBe("TestComponent");
      expect(reported.context.action).toBe("testAction");
      expect(reported.context.severity).toBe(ErrorSeverity.Error);
    });

    it("should respect custom severity levels", () => {
      const error = new Error("critical error");
      const reported = reportError(error, {}, ErrorSeverity.Critical);

      expect(reported.context.severity).toBe(ErrorSeverity.Critical);
    });

    it("should include stack trace when available", () => {
      const error = new Error("test error");
      const reported = reportError(error);

      expect(reported.stack).toBeDefined();
      expect(reported.stack).toContain("Error: test error");
    });

    it("should log to console when configured", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      configureErrorReporting({ logToConsole: true });

      const error = new Error("test error");
      reportError(error);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("withErrorHandling", () => {
    it("should wrap async functions with error handling", async () => {
      const testFn = async (x: number) => x * 2;
      const wrapped = withErrorHandling(testFn, { component: "Test" });

      const result = await wrapped(5);
      expect(result).toBe(10);
    });

    it("should catch and report errors in async functions", async () => {
      const testFn = async () => {
        throw new Error("async error");
      };
      const wrapped = withErrorHandling(testFn, { component: "Test" });

      await expect(wrapped()).rejects.toThrow("async error");
    });

    it("should preserve function arguments", async () => {
      const testFn = async (a: number, b: string, c: boolean) => ({ a, b, c });
      const wrapped = withErrorHandling(testFn);

      const result = await wrapped(42, "test", true);
      expect(result).toEqual({ a: 42, b: "test", c: true });
    });
  });

  describe("withSyncErrorHandling", () => {
    it("should wrap sync functions with error handling", () => {
      const testFn = (x: number) => x * 2;
      const wrapped = withSyncErrorHandling(testFn, { component: "Test" });

      const result = wrapped(5);
      expect(result).toBe(10);
    });

    it("should catch and report errors in sync functions", () => {
      const testFn = () => {
        throw new Error("sync error");
      };
      const wrapped = withSyncErrorHandling(testFn, { component: "Test" });

      expect(() => wrapped()).toThrow("sync error");
    });
  });

  describe("errorStats", () => {
    it("should record error statistics", () => {
      const error1 = new Error("error 1");
      const error2 = new Error("error 2");
      const error3 = new Error("error 1"); // duplicate

      reportErrorWithStats(error1);
      reportErrorWithStats(error2);
      reportErrorWithStats(error3);

      const stats = errorStats.getStats();
      expect(stats.counts["error 1"]).toBe(2);
      expect(stats.counts["error 2"]).toBe(1);
      expect(stats.recent).toHaveLength(3);
    });

    it("should limit recent errors to max size", () => {
      // Record more than maxRecentErrors (50)
      for (let i = 0; i < 60; i++) {
        reportErrorWithStats(new Error(`error ${i}`));
      }

      const stats = errorStats.getStats();
      expect(stats.recent.length).toBeLessThanOrEqual(50);
    });

    it("should clear statistics", () => {
      reportErrorWithStats(new Error("test error"));
      errorStats.clear();

      const stats = errorStats.getStats();
      expect(Object.keys(stats.counts)).toHaveLength(0);
      expect(stats.recent).toHaveLength(0);
    });
  });

  describe("configureErrorReporting", () => {
    it("should update configuration", () => {
      configureErrorReporting({
        logToConsole: true,
        reportToBackend: true,
      });

      // Configuration is internal, so we test the effect
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      reportError(new Error("test"));
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should respect showUserFriendlyMessages config", () => {
      configureErrorReporting({ showUserFriendlyMessages: false });

      const error = new Error("fetch failed");
      const reported = reportError(error);

      expect(reported.userMessage).toBe("fetch failed");
    });
  });
});
