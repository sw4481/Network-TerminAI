import React, { Component, ErrorInfo, ReactNode } from "react";
import { reportError, ErrorSeverity } from "../utils/errorReporting";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  componentName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error Boundary component to catch React component errors
 * Wraps sections of the UI to prevent entire app crashes
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Report error with context
    reportError(error, {
      component: this.props.componentName || "Unknown",
      componentStack: errorInfo.componentStack,
      type: "componentError",
    }, ErrorSeverity.Error);

    // Update state
    this.setState({
      error,
      errorInfo,
    });

    // Call custom error handler if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleReportIssue = (): void => {
    const { error, errorInfo } = this.state;
    if (!error) return;

    // Create GitHub issue URL with error details
    const title = encodeURIComponent(`Error in ${this.props.componentName || "Component"}: ${error.message}`);
    const body = encodeURIComponent(
      `## Error Details\n\n` +
      `**Component:** ${this.props.componentName || "Unknown"}\n` +
      `**Error:** ${error.message}\n\n` +
      `**Stack Trace:**\n\`\`\`\n${error.stack || "No stack trace"}\n\`\`\`\n\n` +
      `**Component Stack:**\n\`\`\`\n${errorInfo?.componentStack || "No component stack"}\n\`\`\`\n\n` +
      `**Browser:** ${navigator.userAgent}\n` +
      `**Timestamp:** ${new Date().toISOString()}\n`
    );

    const issueUrl = `https://github.com/sw4481/Network-TerminAI/issues/new?title=${title}&body=${body}&labels=bug`;
    window.open(issueUrl, "_blank");
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default error UI
      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <h2 style={styles.title}>Something went wrong</h2>
            <p style={styles.message}>
              We're sorry, but something unexpected happened in the {this.props.componentName || "application"}.
            </p>

            {process.env.NODE_ENV === "development" && this.state.error && (
              <details style={styles.details}>
                <summary style={styles.summary}>Error Details (Development Only)</summary>
                <pre style={styles.pre}>
                  <code>{this.state.error.toString()}</code>
                  {this.state.error.stack && (
                    <>
                      {"\n\n"}
                      <code>{this.state.error.stack}</code>
                    </>
                  )}
                </pre>
                {this.state.errorInfo && (
                  <pre style={styles.pre}>
                    <code>{this.state.errorInfo.componentStack}</code>
                  </pre>
                )}
              </details>
            )}

            <div style={styles.actions}>
              <button
                onClick={this.handleReset}
                style={styles.button}
              >
                Try Again
              </button>
              <button
                onClick={this.handleReportIssue}
                style={{ ...styles.button, ...styles.buttonSecondary }}
              >
                Report Issue
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "200px",
    padding: "20px",
    backgroundColor: "var(--surface-2)",
  },
  card: {
    maxWidth: "600px",
    padding: "24px",
    backgroundColor: "var(--surface-terminal)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
  },
  title: {
    margin: "0 0 12px 0",
    fontSize: "20px",
    fontWeight: "600",
    color: "var(--text-primary)",
  },
  message: {
    margin: "0 0 16px 0",
    fontSize: "14px",
    lineHeight: "1.5",
    color: "var(--text-primary)",
  },
  details: {
    marginTop: "16px",
    padding: "12px",
    backgroundColor: "var(--surface-2)",
    borderRadius: "4px",
    fontSize: "12px",
  },
  summary: {
    cursor: "pointer",
    color: "var(--text-primary)",
    marginBottom: "8px",
  },
  pre: {
    margin: "8px 0 0 0",
    padding: "12px",
    backgroundColor: "var(--surface-2)",
    borderRadius: "4px",
    overflow: "auto",
    maxHeight: "300px",
  },
  actions: {
    display: "flex",
    gap: "12px",
    marginTop: "20px",
  },
  button: {
    padding: "8px 16px",
    fontSize: "14px",
    fontWeight: "500",
    color: "var(--text-inverse)",
    backgroundColor: "var(--surface-2)",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    transition: "background-color 0.2s",
  },
  buttonSecondary: {
    backgroundColor: "var(--surface-2)",
  },
};

/**
 * HOC to wrap a component with error boundary
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  componentName?: string
): React.FC<P> {
  return (props: P) => (
    <ErrorBoundary componentName={componentName || Component.displayName || Component.name}>
      <Component {...props} />
    </ErrorBoundary>
  );
}
