import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SpeechRecognitionController,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionHost,
} from "./SpeechRecognitionController";

type FakeResult = Array<{ transcript: string }> & { isFinal: boolean };
type FakeResultEvent = { results: FakeResult[] };

class FakeRecognition {
  static latest: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: FakeResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());

  constructor() {
    FakeRecognition.latest = this;
  }

  emitResults(segments: Array<{ text: string; isFinal: boolean }>) {
    const results = segments.map(({ text, isFinal }) =>
      Object.assign([{ transcript: text }], { isFinal }),
    );
    this.onresult?.({ results });
  }

  emitError(error: string) {
    this.onerror?.({ error });
  }
}

const fakeConstructor = FakeRecognition as unknown as SpeechRecognitionConstructor;

function host(
  constructors: Pick<SpeechRecognitionHost, "SpeechRecognition" | "webkitSpeechRecognition">,
  language = "en-GB",
): SpeechRecognitionHost {
  return {
    navigator: { language },
    ...constructors,
  };
}

function createController(
  recognitionHost: SpeechRecognitionHost = host({ SpeechRecognition: fakeConstructor }),
) {
  const onDraft = vi.fn();
  const onListeningChange = vi.fn();
  const onError = vi.fn();
  const controller = new SpeechRecognitionController(
    { onDraft, onListeningChange, onError },
    recognitionHost,
  );
  return { controller, onDraft, onListeningChange, onError };
}

describe("SpeechRecognitionController", () => {
  beforeEach(() => {
    FakeRecognition.latest = null;
  });

  it("detects unprefixed and WebKit-prefixed constructors", () => {
    expect(
      SpeechRecognitionController.isSupported(
        host({ SpeechRecognition: fakeConstructor }),
      ),
    ).toBe(true);
    expect(
      SpeechRecognitionController.isSupported(
        host({ webkitSpeechRecognition: fakeConstructor }),
      ),
    ).toBe(true);
    expect(
      SpeechRecognitionController.isSupported(host({})),
    ).toBe(false);
  });

  it("configures continuous interim recognition with the host language", () => {
    const { controller, onListeningChange } = createController();

    controller.start("check");

    const fake = FakeRecognition.latest;
    expect(fake).not.toBeNull();
    expect(fake?.continuous).toBe(true);
    expect(fake?.interimResults).toBe(true);
    expect(fake?.lang).toBe("en-GB");
    expect(fake?.start).toHaveBeenCalledOnce();
    expect(onListeningChange).toHaveBeenLastCalledWith(true);
  });

  it("reconstructs the complete transcript on repeated interim results", () => {
    const { controller, onDraft } = createController();
    const fake = () => FakeRecognition.latest!;

    controller.start("check");
    fake().emitResults([
      { text: "interfaces", isFinal: true },
      { text: "status", isFinal: false },
    ]);
    expect(onDraft).toHaveBeenLastCalledWith("check interfaces status");

    fake().emitResults([
      { text: "interfaces", isFinal: true },
      { text: "status", isFinal: false },
    ]);
    expect(onDraft).toHaveBeenLastCalledWith("check interfaces status");
    expect(onDraft).toHaveBeenCalledTimes(2);
  });

  it("preserves a trailing base-draft space without adding another separator", () => {
    const { controller, onDraft } = createController();

    controller.start("check ");
    FakeRecognition.latest?.emitResults([{ text: "interfaces", isFinal: true }]);

    expect(onDraft).toHaveBeenLastCalledWith("check interfaces");
  });

  it("stops gracefully and makes repeated stops idempotent", () => {
    const { controller, onListeningChange } = createController();
    const fake = () => FakeRecognition.latest!;

    controller.start("");
    controller.stop();
    controller.stop();

    expect(fake().stop).toHaveBeenCalledOnce();
    expect(fake().abort).not.toHaveBeenCalled();
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("cancels with abort and ignores late results", () => {
    const { controller, onDraft, onListeningChange } = createController();
    const fake = () => FakeRecognition.latest!;

    controller.start("check");
    controller.cancel();
    controller.cancel();
    fake().emitResults([{ text: "late result", isFinal: true }]);

    expect(fake().abort).toHaveBeenCalledOnce();
    expect(fake().stop).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["not-allowed", "Microphone or speech recognition permission was denied."],
    ["audio-capture", "No microphone is available."],
    ["network", "Speech recognition is unavailable right now."],
    ["service-not-allowed", "Speech recognition is unavailable right now."],
    ["no-speech", "No speech was detected."],
  ])("maps %s recognition errors and clears listening state", (error, message) => {
    const { controller, onError, onListeningChange } = createController();

    controller.start("");
    FakeRecognition.latest?.emitError(error);

    expect(onError).toHaveBeenLastCalledWith(message);
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("guards unsupported and duplicate starts, and maps synchronous start failures", () => {
    const unsupported = createController(host({}));
    unsupported.controller.start("check");
    expect(unsupported.onError).toHaveBeenLastCalledWith(
      "Speech input is unavailable in this WebView; typing still works.",
    );
    expect(unsupported.onListeningChange).not.toHaveBeenCalledWith(true);

    const { controller } = createController();
    controller.start("check");
    controller.start("ignored");
    expect(FakeRecognition.latest?.start).toHaveBeenCalledOnce();

    const throwingRecognition = class extends FakeRecognition {
      override start = vi.fn(() => {
        throw { error: "not-allowed" };
      });
    };
    const throwing = createController(
      host({
        SpeechRecognition:
          throwingRecognition as unknown as SpeechRecognitionConstructor,
      }),
    );
    throwing.controller.start("");
    expect(throwing.onError).toHaveBeenLastCalledWith(
      "Microphone or speech recognition permission was denied.",
    );
    expect(throwing.onListeningChange).not.toHaveBeenCalledWith(true);
  });

  it("disposes active recognition, aborts it, and detaches callbacks", () => {
    const { controller, onDraft, onListeningChange } = createController();
    const fake = () => FakeRecognition.latest!;

    controller.start("check");
    controller.dispose();
    controller.dispose();
    fake().emitResults([{ text: "late result", isFinal: true }]);

    expect(fake().abort).toHaveBeenCalledOnce();
    expect(fake().onstart).toBeNull();
    expect(fake().onresult).toBeNull();
    expect(fake().onerror).toBeNull();
    expect(fake().onend).toBeNull();
    expect(onDraft).not.toHaveBeenCalled();
    expect(onListeningChange).toHaveBeenLastCalledWith(false);
  });
});
