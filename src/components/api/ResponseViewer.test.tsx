import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { ResponseViewer } from "./ResponseViewer";
import type { ApiResponse } from "../../lib/tauri";

// Hoisted mock: apiExplainResponse calls the sidecar LLM. We intercept
// at the Tauri wrapper boundary so tests don't need a running sidecar.
const apiExplainResponseMock = vi.fn();
vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    apiExplainResponse: (...args: unknown[]) =>
      apiExplainResponseMock(...args),
  };
});

function b64(s: string): string {
  // Node-safe base64 for test fixtures.
  if (typeof Buffer !== "undefined") return Buffer.from(s).toString("base64");
  return btoa(s);
}

function make(partial: Partial<ApiResponse> = {}): ApiResponse {
  return {
    status_code: 200,
    status_text: "OK",
    headers: {},
    body: "",
    body_truncated: false,
    duration_ms: 42,
    final_url: "https://example/x",
    error: null,
    ...partial,
  };
}

describe("ResponseViewer", () => {
  beforeEach(() => {
    apiExplainResponseMock.mockReset();
  });

  it("empty state when response is null", () => {
    render(<ResponseViewer response={null} />);
    expect(screen.getByTestId("api-response-empty")).toBeDefined();
  });

  it("2xx status pill + duration render", () => {
    render(
      <ResponseViewer
        response={make({
          status_code: 204,
          status_text: "No Content",
          duration_ms: 123,
        })}
      />,
    );
    const pill = screen.getByTestId("api-response-status");
    expect(pill.textContent).toContain("204");
    expect(pill.textContent).toContain("No Content");
  });

  it("5xx status still shows body and headers", () => {
    render(
      <ResponseViewer
        response={make({
          status_code: 500,
          status_text: "Internal Server Error",
          headers: { "x-error": "db-down" },
          body: b64("kaboom"),
        })}
      />,
    );
    expect(screen.getByTestId("api-response-body").textContent).toContain(
      "kaboom",
    );
    fireEvent.click(screen.getByTestId("api-response-tab-headers"));
    expect(screen.getByTestId("api-response-headers").textContent).toContain(
      "x-error",
    );
  });

  it("pretty-prints JSON bodies", () => {
    render(
      <ResponseViewer
        response={make({
          body: b64('{"orgId":"L_123","name":"lab"}'),
        })}
      />,
    );
    const body = screen.getByTestId("api-response-body");
    // Pretty-printed form contains a newline between keys.
    expect(body.textContent).toMatch(/"orgId":\s*"L_123"/);
    expect(body.textContent).toMatch(/\n/);
  });

  it("renders non-JSON bodies as raw text", () => {
    render(<ResponseViewer response={make({ body: b64("plain text") })} />);
    expect(screen.getByTestId("api-response-body").textContent).toContain(
      "plain text",
    );
  });

  it("empty body shows placeholder", () => {
    render(<ResponseViewer response={make({ status_code: 204, body: "" })} />);
    expect(screen.getByTestId("api-response-body").textContent).toContain(
      "(empty body)",
    );
  });

  it("network error responses surface the error banner", () => {
    render(
      <ResponseViewer
        response={make({
          status_code: 0,
          status_text: "",
          error: "request timed out: operation timed out",
          body: "",
        })}
      />,
    );
    const err = screen.getByTestId("api-response-error");
    expect(err.textContent).toContain("timed out");
    expect(screen.getByTestId("api-response-status").textContent).toContain(
      "ERR",
    );
  });

  it("body_truncated shows a truncation badge", () => {
    render(
      <ResponseViewer
        response={make({ body_truncated: true, body: b64("abc") })}
      />,
    );
    expect(screen.getByTestId("api-body-truncated")).toBeDefined();
  });

  it("headers tab lists every header", () => {
    render(
      <ResponseViewer
        response={make({
          headers: { "content-type": "application/json", "x-trace": "abc" },
          body: b64("{}"),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId("api-response-tab-headers"));
    const h = screen.getByTestId("api-response-headers");
    expect(h.textContent).toContain("content-type");
    expect(h.textContent).toContain("application/json");
    expect(h.textContent).toContain("x-trace");
  });

  it("invalid base64 body renders as an error placeholder", () => {
    render(
      <ResponseViewer
        response={make({ body: "!!!not-base64!!!" })}
      />,
    );
    expect(screen.getByTestId("api-response-body").textContent).toContain(
      "invalid base64",
    );
  });

  it("shows the Table tab when the body is a JSON array of objects", () => {
    render(
      <ResponseViewer
        response={make({
          body: b64(
            JSON.stringify([
              { id: 1, name: "a" },
              { id: 2, name: "b" },
            ]),
          ),
        })}
      />,
    );
    expect(screen.getByTestId("api-response-tab-table")).toBeDefined();
    fireEvent.click(screen.getByTestId("api-response-tab-table"));
    expect(screen.getByTestId("api-table-header-id")).toBeDefined();
  });

  it("hides the Table tab for object responses", () => {
    render(
      <ResponseViewer
        response={make({ body: b64(JSON.stringify({ name: "meraki" })) })}
      />,
    );
    expect(screen.queryByTestId("api-response-tab-table")).toBeNull();
  });

  it("JQ filter prunes the body output", async () => {
    vi.useFakeTimers();
    try {
      render(
        <ResponseViewer
          response={make({
            body: b64(
              JSON.stringify([
                { id: 1, name: "a" },
                { id: 2, name: "b" },
              ]),
            ),
          })}
        />,
      );
      fireEvent.change(screen.getByTestId("api-jq-filter"), {
        target: { value: "$[*].id" },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      const body = screen.getByTestId("api-response-body").textContent ?? "";
      expect(body).toMatch(/1/);
      expect(body).toMatch(/2/);
      expect(body).not.toMatch(/"name"/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalid JQ filter highlights error without breaking the body", async () => {
    vi.useFakeTimers();
    try {
      render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ a: 1 })) })}
        />,
      );
      fireEvent.change(screen.getByTestId("api-jq-filter"), {
        target: { value: "$[?(!!!)" },
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByTestId("api-jq-filter-error")).toBeDefined();
      // Body still renders from the unfiltered parse.
      expect(screen.getByTestId("api-response-body").textContent).toContain(
        '"a"',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("right-clicking the body opens the pipe menu (when tabId is set)", async () => {
    // listTabs is called inside the PipeMenu; mock returns empty.
    const tauri = await import("../../lib/tauri");
    vi.spyOn(tauri, "listTabs").mockResolvedValue([]);
    render(
      <ResponseViewer
        tabId="api-tab-1"
        response={make({ body: b64(JSON.stringify({ a: 1 })) })}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("api-response-body"));
    expect(screen.getByTestId("api-pipe-menu")).toBeDefined();
  });

  describe("Pretty tab", () => {
    it("Pretty tab appears when the body is JSON", () => {
      render(
        <ResponseViewer
          response={make({
            body: b64(JSON.stringify([{ id: "L_1", name: "HQ" }])),
          })}
        />,
      );
      expect(screen.getByTestId("api-response-tab-pretty")).toBeDefined();
    });

    it("Pretty tab does NOT appear for plain-text responses", () => {
      render(<ResponseViewer response={make({ body: b64("hello world") })} />);
      expect(screen.queryByTestId("api-response-tab-pretty")).toBeNull();
    });

    it("clicking Pretty renders a YAML-ish view without JSON syntax", () => {
      render(
        <ResponseViewer
          response={make({
            body: b64(
              JSON.stringify([
                { id: "L_1", name: "HQ" },
                { id: "L_2", name: "Lab" },
              ]),
            ),
          })}
        />,
      );
      fireEvent.click(screen.getByTestId("api-response-tab-pretty"));
      const pane = screen.getByTestId("api-response-pretty");
      // Content preserved…
      expect(pane.textContent).toContain("L_1");
      expect(pane.textContent).toContain("HQ");
      expect(pane.textContent).toContain("Lab");
      // …but JSON syntax stripped.
      expect(pane.textContent).not.toContain("{");
      expect(pane.textContent).not.toContain('"');
    });

    it("Pretty view respects the JQ filter (shares displayValue)", () => {
      vi.useFakeTimers();
      try {
        render(
          <ResponseViewer
            response={make({
              body: b64(
                JSON.stringify([
                  { id: "L_1", name: "HQ" },
                  { id: "L_2", name: "Lab" },
                ]),
              ),
            })}
          />,
        );
        // Filter to just IDs.
        fireEvent.change(screen.getByTestId("api-jq-filter"), {
          target: { value: "$[*].id" },
        });
        act(() => {
          vi.advanceTimersByTime(200);
        });
        fireEvent.click(screen.getByTestId("api-response-tab-pretty"));
        const pane = screen.getByTestId("api-response-pretty");
        expect(pane.textContent).toContain("L_1");
        expect(pane.textContent).toContain("L_2");
        // The "name" key is gone after filtering.
        expect(pane.textContent).not.toContain("name");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Explain button", () => {
    it("Explain button is present when the body is JSON", () => {
      render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ a: 1 })) })}
        />,
      );
      const btn = screen.getByTestId(
        "api-response-explain",
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });

    it("Explain button is disabled when the body is not JSON", () => {
      render(
        <ResponseViewer response={make({ body: b64("just plain text") })} />,
      );
      const btn = screen.getByTestId(
        "api-response-explain",
      ) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("clicking Explain calls apiExplainResponse with method/url/status/body", async () => {
      apiExplainResponseMock.mockResolvedValue("You have 3 organizations.");
      render(
        <ResponseViewer
          requestMethod="GET"
          requestUrl="https://api.meraki.com/api/v1/organizations"
          response={make({
            status_code: 200,
            body: b64(JSON.stringify([{ id: "L_1" }, { id: "L_2" }])),
          })}
        />,
      );
      fireEvent.click(screen.getByTestId("api-response-explain"));
      await waitFor(() =>
        expect(apiExplainResponseMock).toHaveBeenCalledOnce(),
      );
      const args = apiExplainResponseMock.mock.calls[0][0];
      expect(args.method).toBe("GET");
      expect(args.url).toBe(
        "https://api.meraki.com/api/v1/organizations",
      );
      expect(args.statusCode).toBe(200);
      expect(args.body).toContain("L_1");
    });

    it("clicking Explain switches to the Explain tab and renders the summary", async () => {
      apiExplainResponseMock.mockResolvedValue(
        "You have 3 organizations: one production, two lab.",
      );
      render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ foo: 1 })) })}
        />,
      );
      fireEvent.click(screen.getByTestId("api-response-explain"));
      // Immediately flips to the Explain tab.
      await waitFor(() =>
        expect(screen.getByTestId("api-response-tab-explain")).toBeDefined(),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("api-response-explain-text").textContent,
        ).toContain("3 organizations"),
      );
    });

    it("surfaces LLM / IPC errors in the Explain pane", async () => {
      apiExplainResponseMock.mockRejectedValue(
        new Error("ANTHROPIC_API_KEY environment variable not set"),
      );
      render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ a: 1 })) })}
        />,
      );
      fireEvent.click(screen.getByTestId("api-response-explain"));
      await waitFor(() =>
        expect(
          screen.getByTestId("api-response-explain-error").textContent,
        ).toContain("ANTHROPIC_API_KEY"),
      );
    });

    it("resets Explain state when a new response arrives", async () => {
      apiExplainResponseMock.mockResolvedValue("stale summary");
      const { rerender } = render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ a: 1 })) })}
        />,
      );
      fireEvent.click(screen.getByTestId("api-response-explain"));
      await waitFor(() =>
        expect(
          screen.getByTestId("api-response-explain-text").textContent,
        ).toContain("stale summary"),
      );
      // New response comes in — the Explain tab must disappear (no
      // summary for this response yet) and Body becomes the active tab.
      rerender(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ b: 2 })) })}
        />,
      );
      expect(screen.queryByTestId("api-response-tab-explain")).toBeNull();
    });

    it("Explain tab only shows after the button is clicked (or summary exists)", () => {
      render(
        <ResponseViewer
          response={make({ body: b64(JSON.stringify({ a: 1 })) })}
        />,
      );
      // Fresh response → no Explain tab until user opts in.
      expect(screen.queryByTestId("api-response-tab-explain")).toBeNull();
    });
  });
});
