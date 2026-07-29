import { useEffect, useRef, useState, FormEvent } from "react";
import { Workflow, WorkflowParam } from "../lib/workflows";
import "./WorkflowParamForm.css";

export interface WorkflowParamFormProps {
  workflow: Workflow;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  initialValues?: Record<string, string>;
  /** Live typeahead for single-step workflow with params. */
  onValuesChange?: (values: Record<string, string>) => void;
}

function inputTypeFor(p: WorkflowParam): string {
  switch (p.type) {
    case "int":
      return "number";
    case "ip":
      return "text";
    case "interface":
      return "text";
    default:
      return "text";
  }
}

function validate(p: WorkflowParam, value: string): string | null {
  if (p.required && !value.trim()) return "Required";
  if (!value) return null;
  if (p.type === "ip") {
    const ok = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value);
    if (!ok) return "Must be IPv4 (a.b.c.d or a.b.c.d/mask)";
  }
  if (p.type === "int" && !/^-?\d+$/.test(value)) return "Must be integer";
  if (p.type === "enum" && p.enum_values && !p.enum_values.includes(value)) {
    return "Pick a value";
  }
  return null;
}

export function WorkflowParamForm({
  workflow,
  onSubmit,
  onCancel,
  initialValues,
  onValuesChange,
}: WorkflowParamFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const p of workflow.params) {
      seed[p.name] = initialValues?.[p.name] ?? p.default_value ?? "";
    }
    return seed;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    onValuesChange?.(values);
  }, [values, onValuesChange]);

  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onCancel]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const p of workflow.params) {
      const err = validate(p, values[p.name] ?? "");
      if (err) errs[p.name] = err;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit(values);
  };

  const setVal = (name: string, v: string) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <div
      className="wf-param-overlay"
      role="dialog"
      aria-label={`Parameters for ${workflow.name}`}
    >
      <form
        className="wf-param-form"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wf-param-header">
          <h3>{workflow.name}</h3>
          {workflow.description && <p>{workflow.description}</p>}
        </header>
        <div className="wf-param-fields">
          {workflow.params.map((p, i) => (
            <div key={p.name} className="wf-param-field">
              <label htmlFor={`wf-param-${p.name}`}>
                {p.name}
                {p.required && <span className="required">*</span>}
              </label>
              {p.description && (
                <span className="wf-param-desc">{p.description}</span>
              )}
              {p.type === "enum" ? (
                <select
                  id={`wf-param-${p.name}`}
                  ref={(el) => {
                    if (i === 0) firstRef.current = el;
                  }}
                  value={values[p.name] ?? ""}
                  onChange={(e) => setVal(p.name, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(p.enum_values ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`wf-param-${p.name}`}
                  ref={(el) => {
                    if (i === 0) firstRef.current = el;
                  }}
                  type={inputTypeFor(p)}
                  value={values[p.name] ?? ""}
                  onChange={(e) => setVal(p.name, e.target.value)}
                />
              )}
              {errors[p.name] && (
                <span className="wf-param-error">{errors[p.name]}</span>
              )}
            </div>
          ))}
        </div>
        <footer className="wf-param-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Run workflow
          </button>
        </footer>
      </form>
    </div>
  );
}
