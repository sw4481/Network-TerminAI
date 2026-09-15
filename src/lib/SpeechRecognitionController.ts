export type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
};

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: {
    readonly results: ArrayLike<SpeechRecognitionResultLike>;
  }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export type SpeechRecognitionHost = {
  readonly navigator: Pick<Navigator, "language">;
  readonly SpeechRecognition?: SpeechRecognitionConstructor;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export type DictationCallbacks = {
  onDraft: (draft: string) => void;
  onListeningChange: (listening: boolean) => void;
  onError: (message: string) => void;
};

const FALLBACK_MESSAGE =
  "Speech input is unavailable in this WebView; typing still works.";
const PERMISSION_MESSAGE =
  "Microphone or speech recognition permission was denied.";
const MICROPHONE_MESSAGE = "No microphone is available.";
const SERVICE_MESSAGE = "Speech recognition is unavailable right now.";
const NO_SPEECH_MESSAGE = "No speech was detected.";

type SpeechRecognitionGlobals = {
  readonly navigator?: Pick<Navigator, "language">;
  readonly SpeechRecognition?: SpeechRecognitionConstructor;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function getDefaultHost(): SpeechRecognitionHost {
  const globals = globalThis as SpeechRecognitionGlobals;
  return {
    navigator: globals.navigator ?? { language: "" },
    SpeechRecognition: globals.SpeechRecognition,
    webkitSpeechRecognition: globals.webkitSpeechRecognition,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "error" in error) {
    const value = error.error;
    if (typeof value === "string") return value;
  }
  return "";
}

function messageForError(error: unknown): string {
  switch (errorCode(error)) {
    case "not-allowed":
    case "permission-denied":
      return PERMISSION_MESSAGE;
    case "audio-capture":
      return MICROPHONE_MESSAGE;
    case "no-speech":
      return NO_SPEECH_MESSAGE;
    case "network":
    case "service-not-allowed":
    default:
      return SERVICE_MESSAGE;
  }
}

export class SpeechRecognitionController {
  static isSupported(host: SpeechRecognitionHost = getDefaultHost()): boolean {
    return Boolean(host.SpeechRecognition ?? host.webkitSpeechRecognition);
  }

  private readonly callbacks: DictationCallbacks;
  private readonly host: SpeechRecognitionHost;
  private recognition: SpeechRecognitionLike | null = null;
  private baseDraft = "";
  private session = 0;
  private active = false;
  private stopping = false;
  private listening = false;
  private disposed = false;

  constructor(callbacks: DictationCallbacks, host: SpeechRecognitionHost = getDefaultHost()) {
    this.callbacks = callbacks;
    this.host = host;
  }

  start(baseDraft: string): void {
    if (this.disposed || this.active) return;

    const Recognition = this.host.SpeechRecognition ?? this.host.webkitSpeechRecognition;
    if (!Recognition) {
      this.callbacks.onError(FALLBACK_MESSAGE);
      return;
    }

    const session = ++this.session;
    const recognition = new Recognition();
    this.recognition = recognition;
    this.baseDraft = baseDraft;
    this.active = true;
    this.stopping = false;

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.host.navigator.language || "en-US";
    recognition.onstart = () => {
      if (!this.isCurrent(session, recognition)) return;
      this.setListening(true);
    };
    recognition.onresult = (event) => {
      if (!this.isCurrent(session, recognition)) return;

      const segments: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.length > 0) segments.push(result[0].transcript);
      }

      const spokenText = segments
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join(" ");
      const separator =
        this.baseDraft && spokenText && !/\s$/.test(this.baseDraft) ? " " : "";
      this.callbacks.onDraft(`${this.baseDraft}${separator}${spokenText}`);
    };
    recognition.onerror = (event) => {
      if (!this.isCurrent(session, recognition)) return;
      this.finish(session, recognition);
      this.callbacks.onError(messageForError(event.error));
    };
    recognition.onend = () => {
      if (!this.isCurrent(session, recognition)) return;
      this.finish(session, recognition);
    };

    try {
      recognition.start();
    } catch (error) {
      if (!this.isCurrent(session, recognition)) return;
      this.finish(session, recognition);
      this.callbacks.onError(messageForError(error));
    }
  }

  stop(): void {
    if (!this.active || !this.recognition || this.stopping) return;
    this.stopping = true;
    try {
      this.recognition.stop();
    } catch (error) {
      const recognition = this.recognition;
      const session = this.session;
      this.finish(session, recognition);
      this.callbacks.onError(messageForError(error));
    }
  }

  cancel(): void {
    if (!this.active || !this.recognition) return;

    const recognition = this.recognition;
    this.active = false;
    this.session += 1;
    this.stopping = false;
    this.recognition = null;
    this.detach(recognition);
    this.setListening(false);
    try {
      recognition.abort();
    } catch {
      // Aborting is best-effort; cancellation has already made this session inert.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const recognition = this.recognition;
    if (recognition && this.active) {
      this.active = false;
      this.session += 1;
      this.recognition = null;
      this.detach(recognition);
      this.setListening(false);
      try {
        recognition.abort();
      } catch {
        // Disposal must remain idempotent even if the browser rejects abort().
      }
    }
  }

  private isCurrent(
    session: number,
    recognition: SpeechRecognitionLike,
  ): boolean {
    return (
      !this.disposed &&
      this.active &&
      this.session === session &&
      this.recognition === recognition
    );
  }

  private finish(session: number, recognition: SpeechRecognitionLike): void {
    if (!this.isCurrent(session, recognition)) return;
    this.active = false;
    this.stopping = false;
    this.recognition = null;
    this.detach(recognition);
    this.setListening(false);
  }

  private detach(recognition: SpeechRecognitionLike): void {
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }

  private setListening(listening: boolean): void {
    if (this.listening === listening) return;
    this.listening = listening;
    this.callbacks.onListeningChange(listening);
  }
}
