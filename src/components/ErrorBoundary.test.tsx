import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary, withErrorBoundary } from "./ErrorBoundary";
import * as errorReporting from "../utils/errorReporting";

// Component that throws an error
function ThrowError({ shouldThrow = false }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error("Test error");
  }
  return <div>No error</div>;
}

describe("ErrorBoundary", () => {
  // Suppress console errors in tests
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("should render children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText("Test content")).toBeDefined();
  });

  it("should catch errors and display fallback UI", () => {
    render(
      <ErrorBoundary componentName="TestComponent">
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Something went wrong/i)).toBeDefined();
  });

  it("should display component name in error message", () => {
    render(
      <ErrorBoundary componentName="MyComponent">
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText(/MyComponent/i)).toBeDefined();
  });

  it("should call reportError when error is caught", () => {
    const reportErrorSpy = vi.spyOn(errorReporting, "reportError");

    render(
      <ErrorBoundary componentName="TestComponent">
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(reportErrorSpy).toHaveBeenCalled();
    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        component: "TestComponent",
        type: "componentError",
      }),
      errorReporting.ErrorSeverity.Error
    );
  });

  it("should call onError callback when provided", () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  it("should render custom fallback when provided", () => {
    const customFallback = <div>Custom error message</div>;

    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Custom error message")).toBeDefined();
  });

  it("should show Try Again button", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Try Again")).toBeDefined();
  });

  it("should show Report Issue button", () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Report Issue")).toBeDefined();
  });
});

describe("withErrorBoundary HOC", () => {
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });

  afterEach(() => {
    console.error = originalError;
  });

  it("should wrap component with error boundary", () => {
    const TestComponent = () => <div>Test</div>;
    const WrappedComponent = withErrorBoundary(TestComponent, "TestComponent");

    render(<WrappedComponent />);
    expect(screen.getByText("Test")).toBeDefined();
  });

  it("should catch errors in wrapped component", () => {
    const WrappedComponent = withErrorBoundary(ThrowError, "ThrowError");

    render(<WrappedComponent shouldThrow={true} />);
    expect(screen.getByText(/Something went wrong/i)).toBeDefined();
  });

  it("should use component name for error reporting", () => {
    const reportErrorSpy = vi.spyOn(errorReporting, "reportError");
    const TestComponent = () => {
      throw new Error("Test");
    };
    TestComponent.displayName = "MyTestComponent";

    const WrappedComponent = withErrorBoundary(TestComponent);

    render(<WrappedComponent />);

    expect(reportErrorSpy).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        component: "MyTestComponent",
      }),
      expect.any(String)
    );
  });
});
