import { useEffect, useRef, useState } from "react";
import { agentCatalogUpdateStart, agentCatalogUpdateStatus, type ApiCatalogUpdateResult, type CiscoApiProduct } from "../../lib/tauri";

export function ApiCatalogUpdateControl({ agentId, label }: { agentId: CiscoApiProduct; label: string }) {
  const [result, setResult] = useState<ApiCatalogUpdateResult | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const start = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setResult(null);
    setError(null);
    setPending(true);
    async function request(update: boolean, jobId?: string) {
      setPending(true);
      setError(null);
      try {
        const next = update
          ? await agentCatalogUpdateStart(agentId)
          : jobId ? await agentCatalogUpdateStatus(agentId, jobId) : await agentCatalogUpdateStatus(agentId);
        if (cancelled) return;
        setResult(next);
        if (next.state === "running") {
          timer = setTimeout(() => { void request(false, next.job_id ?? undefined); }, 1000);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(String(cause));
          setResult(null);
        }
      } finally {
        if (!cancelled) setPending(false);
      }
    }
    start.current = () => { void request(true); };
    void request(false);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      start.current = null;
    };
  }, [agentId]);

  const running = result?.state === "running";
  const failure = error ?? result?.error;
  return (
    <section className="tab-content" aria-label={`${label} API catalog`}>
      <h3>{label} API catalog</h3>
      <p className="muted">Add compatible APIs from this product’s published references only. Existing entries, connection settings and prompts stay unchanged.</p>
      <button className="primary" aria-label={`Update APIs for ${label}`} disabled={pending || running} onClick={() => start.current?.()}>
        Update APIs
      </button>
      <p role="status" aria-live="polite">
        {running ? `${label}: ${result.phase ?? "working"}` : result?.state === "completed"
          ? `${label}: ${result.added} added · ${result.already_known} already known · ${result.skipped} skipped`
          : pending ? `${label}: checking update status…` : `${label}: no update running`}
      </p>
      {failure && <p role="alert">{label}: {failure}</p>}
      {result?.checked_at && <p className="muted">Last check: {result.checked_at}</p>}
      {!!result?.warnings.length && <ul aria-label={`${label} update warnings`}>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {!!result?.source_urls.length && <details><summary>Checked sources</summary><ul>{result.source_urls.map(url => <li key={url}>{url}</li>)}</ul></details>}
      <p className="muted">Start a new agent run to use additions. A completed check does not mean every API or your installed product version is covered.</p>
    </section>
  );
}
