/**
 * Centralized error reporting and handling for CCIE Terminal
 */

export interface ErrorContext {
  component?: string;
  action?: string;
  userId?: string;
  timestamp?: string;
  [key: string]: any;
}

export interface ReportedError {
  message: string;
  userMessage: string;
  stack?: string;
  context: ErrorContext;
  timestamp: string;
}

/**
 * Error severity levels
 */
export enum ErrorSeverity {
  Info = "info",
  Warning = "warning",
  Error = "error",
  Critical = "critical",
}

/**
 * Configuration for error reporting
 */
interface ErrorReportingConfig {
  logToConsole: boolean;
  reportToBackend: boolean;
  showUserFriendlyMessages: boolean;
}

const defaultConfig: ErrorReportingConfig = {
  logToConsole: true,
  reportToBackend: false, // Will be enabled when backend endpoint is ready
  showUserFriendlyMessages: true,
};

let config = { ...defaultConfig };

/**
 * Configure error reporting behavior
 */
export function configureErrorReporting(newConfig: Partial<ErrorReportingConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Convert technical error messages to user-friendly ones
 */
export function getUserFriendlyMessage(error: Error): string {
  const message = error.message.toLowerCase();

  // Network errors
  if (message.includes("fetch") || message.includes("network")) {
    return "Unable to connect. Please check your internet connection and try again.";
  }

  // Permission errors
  if (message.includes("permission") || message.includes("denied")) {
    return "Permission denied. Please check your access rights.";
  }

  // Timeout errors
  if (message.includes("timeout")) {
    return "The operation took too long to complete. Please try again.";
  }

  // File system errors
  if (message.includes("enoent") || message.includes("file not found")) {
    return "The requested file or directory could not be found.";
  }

  // PTY errors
  if (message.includes("pty") || message.includes("spawn")) {
    return "Unable to start terminal session. Please restart the application.";
  }

  // Database errors
  if (message.includes("database") || message.includes("sql")) {
    return "A data storage error occurred. Your session data may not be saved correctly.";
  }

  // MCP server errors
  if (message.includes("mcp") || message.includes("server")) {
    return "Unable to connect to the AI service. Some features may be unavailable.";
  }

  // Generic fallback
  return "An unexpected error occurred. Please try again.";
}

/**
 * Report an error with context
 */
export function reportError(
  error: Error,
  context: ErrorContext = {},
  severity: ErrorSeverity = ErrorSeverity.Error
): ReportedError {
  const timestamp = new Date().toISOString();
  const userMessage = config.showUserFriendlyMessages
    ? getUserFriendlyMessage(error)
    : error.message;

  const reportedError: ReportedError = {
    message: error.message,
    userMessage,
    stack: error.stack,
    context: {
      ...context,
      severity,
      timestamp,
    },
    timestamp,
  };

  // Log to console in development
  if (config.logToConsole) {
    const logMethod = severity === ErrorSeverity.Critical ? "error" :
                      severity === ErrorSeverity.Error ? "error" :
                      severity === ErrorSeverity.Warning ? "warn" : "info";

    console[logMethod]("[Error Report]", {
      message: reportedError.message,
      userMessage: reportedError.userMessage,
      context: reportedError.context,
      stack: reportedError.stack,
    });
  }

  // Send to backend (when implemented)
  if (config.reportToBackend) {
    sendToBackend(reportedError).catch((err) => {
      console.error("Failed to report error to backend:", err);
    });
  }

  return reportedError;
}

/**
 * Send error report to backend logging service
 */
async function sendToBackend(error: ReportedError): Promise<void> {
  // This will be implemented when we have a backend endpoint
  // For now, we could use Tauri commands to log to Rust backend
  try {
    // Example: await invoke("log_frontend_error", { error });
    console.debug("Backend error reporting not yet implemented");
  } catch (err) {
    // Silently fail - don't want error reporting to cause more errors
    console.debug("Failed to send error to backend:", err);
  }
}

/**
 * Wrap an async function with error handling
 */
export function withErrorHandling<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  context: ErrorContext = {}
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    try {
      return await fn(...args);
    } catch (error) {
      reportError(
        error instanceof Error ? error : new Error(String(error)),
        context,
        ErrorSeverity.Error
      );
      throw error; // Re-throw to let caller handle
    }
  };
}

/**
 * Wrap a sync function with error handling
 */
export function withSyncErrorHandling<T extends any[], R>(
  fn: (...args: T) => R,
  context: ErrorContext = {}
): (...args: T) => R {
  return (...args: T): R => {
    try {
      return fn(...args);
    } catch (error) {
      reportError(
        error instanceof Error ? error : new Error(String(error)),
        context,
        ErrorSeverity.Error
      );
      throw error; // Re-throw to let caller handle
    }
  };
}

/**
 * Global error handler for uncaught errors
 */
export function setupGlobalErrorHandler(): void {
  // Handle uncaught promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    reportError(
      new Error(event.reason?.message || String(event.reason)),
      { type: "unhandledRejection" },
      ErrorSeverity.Critical
    );
  });

  // Handle uncaught errors
  window.addEventListener("error", (event) => {
    event.preventDefault();
    reportError(
      event.error || new Error(event.message),
      {
        type: "uncaughtError",
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
      ErrorSeverity.Critical
    );
  });
}

/**
 * Get error statistics (useful for debugging and monitoring)
 */
class ErrorStats {
  private errorCounts: Map<string, number> = new Map();
  private recentErrors: ReportedError[] = [];
  private maxRecentErrors = 50;

  recordError(error: ReportedError): void {
    // Count by message
    const count = this.errorCounts.get(error.message) || 0;
    this.errorCounts.set(error.message, count + 1);

    // Keep recent errors
    this.recentErrors.push(error);
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors.shift();
    }
  }

  getStats(): { counts: Record<string, number>; recent: ReportedError[] } {
    return {
      counts: Object.fromEntries(this.errorCounts),
      recent: [...this.recentErrors],
    };
  }

  clear(): void {
    this.errorCounts.clear();
    this.recentErrors = [];
  }
}

export const errorStats = new ErrorStats();

// Export a version of reportError that also records stats
const originalReportError = reportError;
export { originalReportError as reportErrorWithoutStats };

export function reportErrorWithStats(
  error: Error,
  context: ErrorContext = {},
  severity: ErrorSeverity = ErrorSeverity.Error
): ReportedError {
  const reported = originalReportError(error, context, severity);
  errorStats.recordError(reported);
  return reported;
}
