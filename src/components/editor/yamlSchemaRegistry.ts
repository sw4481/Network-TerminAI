import { configureMonacoYaml } from "monaco-yaml";
import type * as Monaco from "monaco-editor";
import YamlWorker from "monaco-yaml/yaml.worker?worker";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

let workersInstalled = false;
function installYamlWorker() {
  if (workersInstalled) return;
  const host = globalThis as typeof globalThis & {
    MonacoEnvironment?: Monaco.Environment;
  };
  const previous = host.MonacoEnvironment;
  host.MonacoEnvironment = {
    ...previous,
    getWorker(moduleId, label) {
      if (label === "yaml") return new YamlWorker();
      return previous?.getWorker
        ? previous.getWorker(moduleId, label)
        : new EditorWorker();
    },
  };
  workersInstalled = true;
}

type Service = Pick<
  ReturnType<typeof configureMonacoYaml>,
  "update" | "dispose"
>;
type Configure = (
  monaco: typeof Monaco,
  options: Parameters<typeof configureMonacoYaml>[1],
) => Service;
type Entry = { schema: object; references: number };
type Host = {
  documents: Map<string, Entry>;
  service: Service;
  pending: Promise<unknown>;
};

export class YamlSchemaRegistry {
  private readonly hosts = new Map<typeof Monaco, Host>();
  constructor(private readonly configure: Configure = configureMonacoYaml) {}

  acquire(
    monaco: typeof Monaco,
    uri: string,
    schema: object,
  ): { release(): void } {
    installYamlWorker();
    let host = this.hosts.get(monaco);
    if (!host) {
      host = {
        documents: new Map(),
        service: this.configure(monaco, {
          validate: true,
          enableSchemaRequest: false,
          schemas: [],
        }),
        pending: Promise.resolve(),
      };
      this.hosts.set(monaco, host);
    }
    const entry = host.documents.get(uri);
    if (entry) {
      entry.references++;
      entry.schema = schema;
    } else host.documents.set(uri, { schema, references: 1 });
    this.update(host);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = host.documents.get(uri);
        if (!current || --current.references > 0) return;
        host.documents.delete(uri);
        const model = monaco.editor.getModel(monaco.Uri.parse(uri));
        if (model) monaco.editor.setModelMarkers(model, "yaml", []);
        this.update(host);
        if (!host.documents.size) {
          // Updates finish before disposal so an old revalidation cannot revive diagnostics.
          host.pending = host.pending.finally(() => {
            if (!host.documents.size) {
              host.service.dispose();
              this.hosts.delete(monaco);
            }
          });
        }
      },
    };
  }
  private update(host: Host) {
    const schemas = [...host.documents].map(([uri, { schema }]) => ({
      uri: `${uri}.schema.json`,
      fileMatch: [uri],
      schema,
    }));
    host.pending = host.pending
      .catch(() => {})
      .then(() => host.service.update({ schemas }));
  }
  async settled() {
    await Promise.all([...this.hosts.values()].map((host) => host.pending));
  }
}
export const yamlSchemaRegistry = new YamlSchemaRegistry();
