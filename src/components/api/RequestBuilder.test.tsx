import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RequestBuilder } from "./RequestBuilder";
import { useApiRunner } from "../../state/apiRunnerStore";

function reset() {
  act(() => {
    useApiRunner.setState({ tabs: {} });
  });
}

function renderBuilder(tabId = "t1", onSend = vi.fn()) {
  useApiRunner.getState().ensure(tabId);
  return {
    onSend,
    ...render(<RequestBuilder tabId={tabId} onSend={onSend} />),
  };
}

describe("RequestBuilder", () => {
  beforeEach(reset);

  it("renders method dropdown and URL input", () => {
    renderBuilder();
    expect(screen.getByTestId("api-method")).toBeDefined();
    expect(screen.getByTestId("api-url")).toBeDefined();
  });

  it("method change updates store", () => {
    renderBuilder("t1");
    const method = screen.getByTestId("api-method") as HTMLSelectElement;
    fireEvent.change(method, { target: { value: "POST" } });
    expect(useApiRunner.getState().tabs.t1.method).toBe("POST");
  });

  it("URL input updates store", () => {
    renderBuilder("t1");
    const url = screen.getByTestId("api-url") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://x.example/v1/orgs" } });
    expect(useApiRunner.getState().tabs.t1.url).toBe(
      "https://x.example/v1/orgs",
    );
  });

  it("Send is disabled when URL is empty", () => {
    renderBuilder();
    const send = screen.getByTestId("api-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("Send is disabled for non-http URLs", () => {
    renderBuilder("t1");
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "not a url" },
    });
    expect((screen.getByTestId("api-send") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("Send is enabled for https URL and fires onSend", () => {
    const { onSend } = renderBuilder("t1");
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://a.example" },
    });
    const send = screen.getByTestId("api-send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("Send is disabled while sending flag is set", () => {
    renderBuilder("t1");
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://a.example" },
    });
    act(() => {
      useApiRunner.getState().setSending("t1", true);
    });
    const send = screen.getByTestId("api-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.textContent).toContain("Sending");
  });

  it("switching to headers panel shows the KV editor", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-headers"));
    expect(screen.getByTestId("api-header-editor")).toBeDefined();
  });

  it("adding a header row persists to the store", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-headers"));
    fireEvent.click(screen.getByTestId("api-header-add"));
    const state = useApiRunner.getState().tabs.t1;
    expect(state.headers).toHaveLength(1);
  });

  it("auth type switch to Bearer shows token input", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "bearer" },
    });
    expect(screen.getByTestId("api-auth-bearer-token")).toBeDefined();
    expect(useApiRunner.getState().tabs.t1.auth).toEqual({
      type: "bearer",
      token: "",
    });
  });

  it("auth type switch to Basic shows both user and pass inputs", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "basic" },
    });
    expect(screen.getByTestId("api-auth-basic-user")).toBeDefined();
    expect(screen.getByTestId("api-auth-basic-pass")).toBeDefined();
  });

  it("auth type switch to Header shows name and value inputs", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "header" },
    });
    expect(screen.getByTestId("api-auth-header-name")).toBeDefined();
    expect(screen.getByTestId("api-auth-header-value")).toBeDefined();
  });

  it("auth type switch to Token Login seeds sensible defaults", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "token_login" },
    });
    // Default: jsonpath = $.Token, header apply = X-Auth-Token, refresh_on_status = [401]
    const jp = screen.getByTestId(
      "api-auth-token-login-jsonpath",
    ) as HTMLInputElement;
    expect(jp.value).toBe("$.Token");
    const hn = screen.getByTestId(
      "api-auth-token-header-name",
    ) as HTMLInputElement;
    expect(hn.value).toBe("X-Auth-Token");
    const stored = useApiRunner.getState().tabs.t1.auth;
    expect(stored.type).toBe("token_login");
    if (stored.type === "token_login") {
      expect(stored.refresh_on_status).toEqual([401]);
    }
  });

  it("Token Login credentials flow into the store", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "token_login" },
    });
    fireEvent.change(screen.getByTestId("api-auth-token-login-url"), {
      target: { value: "/dna/auth/token" },
    });
    fireEvent.change(screen.getByTestId("api-auth-token-login-user"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByTestId("api-auth-token-login-pass"), {
      target: { value: "pw" },
    });
    const stored = useApiRunner.getState().tabs.t1.auth;
    expect(stored.type).toBe("token_login");
    if (stored.type === "token_login") {
      expect(stored.login.url).toBe("/dna/auth/token");
      if (stored.login.credentials.type === "basic") {
        expect(stored.login.credentials.username).toBe("admin");
        expect(stored.login.credentials.password).toBe("pw");
      }
    }
  });

  it("Token Login apply can switch between header and bearer", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "token_login" },
    });
    fireEvent.change(screen.getByTestId("api-auth-token-apply"), {
      target: { value: "bearer" },
    });
    const stored = useApiRunner.getState().tabs.t1.auth;
    if (stored.type === "token_login") {
      expect(stored.apply).toEqual({ mode: "bearer" });
    } else {
      throw new Error("expected token_login auth");
    }
    // header-name input should disappear when in bearer mode.
    expect(screen.queryByTestId("api-auth-token-header-name")).toBeNull();
  });

  it("Session Cookie auth shows login URL + credentials", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "session_cookie" },
    });
    expect(screen.getByTestId("api-auth-session-url")).toBeDefined();
    expect(screen.getByTestId("api-auth-session-user")).toBeDefined();
    expect(screen.getByTestId("api-auth-session-pass")).toBeDefined();
  });

  it("Hook auth shows module + function inputs and default function", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.change(screen.getByTestId("api-auth-type"), {
      target: { value: "hook" },
    });
    const fnInput = screen.getByTestId(
      "api-auth-hook-function",
    ) as HTMLInputElement;
    expect(fnInput.value).toBe("sign_request");
    fireEvent.change(screen.getByTestId("api-auth-hook-module"), {
      target: { value: "intersight_hmac" },
    });
    const stored = useApiRunner.getState().tabs.t1.auth;
    if (stored.type === "hook") {
      expect(stored.module).toBe("intersight_hmac");
      expect(stored.function).toBe("sign_request");
    }
  });

  it("TLS skip-verify checkbox updates store", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-auth"));
    fireEvent.click(screen.getByTestId("api-tls-skip-verify"));
    expect(useApiRunner.getState().tabs.t1.insecure_skip_verify).toBe(true);
  });

  it("body panel: JSON kind reveals textarea", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-body"));
    fireEvent.change(screen.getByTestId("api-body-kind"), {
      target: { value: "json" },
    });
    expect(screen.getByTestId("api-body-text")).toBeDefined();
    fireEvent.change(screen.getByTestId("api-body-text"), {
      target: { value: '{"x":1}' },
    });
    expect(useApiRunner.getState().tabs.t1.body_text).toBe('{"x":1}');
  });

  it("body panel: None kind hides the textarea", () => {
    renderBuilder("t1");
    fireEvent.click(screen.getByTestId("api-panel-body"));
    // default is "none"
    expect(screen.queryByTestId("api-body-text")).toBeNull();
  });

  it("two tabs rendered in sequence stay isolated", () => {
    const { unmount } = renderBuilder("t1");
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://one.example" },
    });
    unmount();
    renderBuilder("t2");
    fireEvent.change(screen.getByTestId("api-url"), {
      target: { value: "https://two.example" },
    });
    expect(useApiRunner.getState().tabs.t1.url).toBe("https://one.example");
    expect(useApiRunner.getState().tabs.t2.url).toBe("https://two.example");
  });
});
