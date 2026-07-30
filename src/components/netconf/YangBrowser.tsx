import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  yangReleaseList,
  yangReleaseDownload,
  yangReleaseDelete,
  yangModuleList,
  yangModuleContent,
  yangExplainModule,
  type YangRelease,
  type YangModule,
} from "../../lib/tauri";
import { PipeMenu, type PipeTarget } from "../api/PipeMenu";

type Props = {
  tabId: string;
  onClose: () => void;
  onInsertXml?: (xml: string) => void;
};

type View = "releases" | "modules";

export function YangBrowser({ tabId, onClose, onInsertXml }: Props) {
  const [view, setView] = useState<View>("releases");
  const [releases, setReleases] = useState<YangRelease[]>([]);
  const [selectedRelease, setSelectedRelease] = useState<YangRelease | null>(null);
  const [modules, setModules] = useState<YangModule[]>([]);
  const [moduleQuery, setModuleQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedModule, setSelectedModule] = useState<YangModule | null>(null);
  const [moduleContent, setModuleContent] = useState<string>("");
  const [loadingContent, setLoadingContent] = useState(false);
  const [explanation, setExplanation] = useState<string>("");
  const [explaining, setExplaining] = useState(false);
  const [menu, setMenu] = useState<PipeTarget | null>(null);

  // Download form state
  const [downloadVendor, setDownloadVendor] = useState("cisco");
  const [downloadOs, setDownloadOs] = useState("xe");
  const [downloadRelease, setDownloadRelease] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{done: number, total: number, file: string} | null>(null);

  useEffect(() => {
    loadReleases();
  }, []);

  const loadReleases = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await yangReleaseList();
      setReleases(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadRelease.trim()) {
      setError("Release version is required");
      return;
    }

    setDownloading(true);
    setDownloadProgress(null);
    setError(null);

    // Listen for progress events
    const unlisten = await listen<any>("yang-download-progress", (event) => {
      const data = event.payload;
      if (data.type === "indexing") {
        setDownloadProgress({
          done: 0,
          total: 0,
          file: "Indexing modules...",
        });
      } else if (data.type === "progress" && data.files_done && data.files_total) {
        setDownloadProgress({
          done: data.files_done,
          total: data.files_total,
          file: data.current_file || "",
        });
      }
    });

    try {
      await yangReleaseDownload(downloadVendor, downloadOs, downloadRelease.trim());
      setDownloadRelease("");
      await loadReleases();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
      setDownloadProgress(null);
      unlisten();
    }
  };

  const handleDelete = async (release: YangRelease) => {
    if (!confirm(`Delete ${release.vendor}/${release.os}/${release.release}?`)) return;
    try {
      await yangReleaseDelete(release.id);
      await loadReleases();
      if (selectedRelease?.id === release.id) {
        setSelectedRelease(null);
        setView("releases");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSelectRelease = async (release: YangRelease) => {
    setSelectedRelease(release);
    setView("modules");
    setLoading(true);
    setError(null);
    try {
      const data = await yangModuleList(release.id, moduleQuery || undefined);
      setModules(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSearchModules = async () => {
    if (!selectedRelease) return;
    setLoading(true);
    try {
      const data = await yangModuleList(selectedRelease.id, moduleQuery || undefined);
      setModules(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleModuleClick = async (module: YangModule) => {
    setSelectedModule(module);
    setLoadingContent(true);
    setError(null);
    setExplanation("");
    try {
      const content = await yangModuleContent(module.file_path);
      setModuleContent(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingContent(false);
    }
  };

  const handleExplain = async () => {
    if (!selectedModule || !moduleContent) return;
    setExplaining(true);
    setError(null);
    try {
      const summary = await yangExplainModule(selectedModule.name, moduleContent);
      setExplanation(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  };

  const openMenu = (
    value: unknown,
    label: string | undefined,
    e: { clientX: number; clientY: number },
  ) => {
    setMenu({
      sourceTabId: tabId,
      value,
      label,
      x: e.clientX,
      y: e.clientY,
    });
  };

  return (
    <div
      data-testid="yang-browser"
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 600,
        background: "var(--surface-2)",
        borderLeft: "1px solid var(--border-default)",
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            YANG Browser
          </div>
          {view === "modules" && selectedRelease && (
            <>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>/</div>
              <button
                onClick={() => setView("releases")}
                style={{
                  background: "transparent",
                  color: "var(--accent)",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: 0,
                }}
              >
                {selectedRelease.vendor}/{selectedRelease.os}/{selectedRelease.release}
              </button>
            </>
          )}
        </div>
        <button
          data-testid="yang-browser-close"
          onClick={onClose}
          style={{
            background: "transparent",
            color: "var(--text-secondary)",
            border: "1px solid var(--border-default)",
            borderRadius: 4,
            padding: "4px 8px",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Close
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: 12,
            background: "var(--surface-2)",
            borderBottom: "1px solid var(--border-default)",
            color: "var(--status-danger)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}>
        {/* Module list */}
        <div style={{ flex: selectedModule ? 0.4 : 1, overflowY: "auto", padding: 12, borderRight: selectedModule ? "1px solid var(--border-default)" : "none" }}>
        {view === "releases" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Download form */}
            <div
              style={{
                background: "var(--app-canvas)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                padding: 12,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 10 }}>
                Download Release
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <select
                    value={downloadVendor}
                    onChange={(e) => setDownloadVendor(e.target.value)}
                    disabled={downloading}
                    style={{
                      flex: 1,
                      background: "var(--surface-2)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      padding: "6px 8px",
                      fontSize: 11,
                      fontFamily: "Menlo, monospace",
                    }}
                  >
                    <option value="cisco">Cisco</option>
                    <option value="juniper">Juniper</option>
                    <option value="arista">Arista</option>
                  </select>
                  <select
                    value={downloadOs}
                    onChange={(e) => setDownloadOs(e.target.value)}
                    disabled={downloading}
                    style={{
                      flex: 1,
                      background: "var(--surface-2)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      padding: "6px 8px",
                      fontSize: 11,
                      fontFamily: "Menlo, monospace",
                    }}
                  >
                    {downloadVendor === "cisco" && (
                      <>
                        <option value="xe">IOS-XE</option>
                        <option value="xr">IOS-XR</option>
                        <option value="nxos">NX-OS</option>
                      </>
                    )}
                    {downloadVendor === "juniper" && (
                      <option value="junos">Junos</option>
                    )}
                    {downloadVendor === "arista" && (
                      <option value="eos">EOS</option>
                    )}
                  </select>
                </div>
                <input
                  type="text"
                  value={downloadRelease}
                  onChange={(e) => setDownloadRelease(e.target.value)}
                  placeholder="Release (e.g., 1715, 17.15.1)"
                  disabled={downloading}
                  style={{
                    background: "var(--surface-2)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 4,
                    padding: "6px 8px",
                    fontSize: 11,
                    fontFamily: "Menlo, monospace",
                  }}
                />
                <button
                  onClick={handleDownload}
                  disabled={downloading}
                  style={{
                    background: downloading ? "var(--surface-3)" : "var(--accent-subtle)",
                    color: downloading ? "var(--text-muted)" : "var(--text-primary)",
                    border: "none",
                    borderRadius: 4,
                    padding: "8px 12px",
                    cursor: downloading ? "wait" : "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {downloading ? "Downloading..." : "Download"}
                </button>
                {downloadProgress && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                      {downloadProgress.total === 0 ? (
                        downloadProgress.file
                      ) : (
                        <>
                          {downloadProgress.done} / {downloadProgress.total} files
                          {downloadProgress.file && ` - ${downloadProgress.file}`}
                        </>
                      )}
                    </div>
                    <div
                      style={{
                        height: 4,
                        background: "var(--surface-3)",
                        borderRadius: 2,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          background: "var(--accent)",
                          width: downloadProgress.total === 0 ? "100%" : `${(downloadProgress.done / downloadProgress.total) * 100}%`,
                          transition: "width 0.2s",
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Releases list */}
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              Downloaded Releases
            </div>

            {loading && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
                Loading...
              </div>
            )}

            {!loading && releases.length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                No releases downloaded yet
              </div>
            )}

            {releases.map((release) => (
              <div
                key={release.id}
                style={{
                  background: "var(--app-canvas)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                    {release.vendor}/{release.os}/{release.release}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {release.module_count} modules
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => handleSelectRelease(release)}
                    style={{
                      background: "var(--accent-subtle)",
                      color: "var(--text-primary)",
                      border: "none",
                      borderRadius: 4,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    Browse
                  </button>
                  <button
                    onClick={() => handleDelete(release)}
                    style={{
                      background: "transparent",
                      color: "var(--status-danger)",
                      border: "1px solid var(--border-default)",
                      borderRadius: 4,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {view === "modules" && selectedRelease && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Module search */}
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={moduleQuery}
                onChange={(e) => setModuleQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearchModules()}
                placeholder="Search modules..."
                style={{
                  flex: 1,
                  background: "var(--surface-2)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  padding: "6px 8px",
                  fontSize: 11,
                  fontFamily: "Menlo, monospace",
                }}
              />
              <button
                onClick={handleSearchModules}
                style={{
                  background: "var(--accent-subtle)",
                  color: "var(--text-primary)",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Search
              </button>
            </div>

            {/* Modules list */}
            {loading && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
                Loading modules...
              </div>
            )}

            {!loading && modules.length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                {moduleQuery ? "No modules match your search" : "No modules found"}
              </div>
            )}

            {modules.map((module) => (
              <div
                key={module.id}
                onClick={() => handleModuleClick(module)}
                style={{
                  background: selectedModule?.id === module.id ? "var(--surface-selected)" : "var(--app-canvas)",
                  border: `1px solid ${selectedModule?.id === module.id ? "var(--accent-subtle)" : "var(--border-default)"}`,
                  borderRadius: 4,
                  padding: 10,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
                  {module.name}
                </div>
                {module.namespace && (
                  <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 2 }}>
                    {module.namespace}
                  </div>
                )}
                {module.revision && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    Revision: {module.revision}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        </div>

        {/* Module detail panel */}
        {selectedModule && (
          <div style={{ flex: 0.6, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Detail header */}
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-default)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                  {selectedModule.name}
                </div>
                <button
                  onClick={() => setSelectedModule(null)}
                  style={{
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 4,
                    padding: "4px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  Close
                </button>
              </div>
              {selectedModule.namespace && (
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
                  {selectedModule.namespace}
                </div>
              )}
              {selectedModule.revision && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  Revision: {selectedModule.revision}
                </div>
              )}
              <button
                onClick={handleExplain}
                disabled={explaining || loadingContent}
                style={{
                  background: explaining || loadingContent ? "var(--surface-3)" : "var(--accent-subtle)",
                  color: explaining || loadingContent ? "var(--text-muted)" : "var(--text-primary)",
                  border: "none",
                  borderRadius: 4,
                  padding: "6px 12px",
                  cursor: explaining || loadingContent ? "wait" : "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {explaining ? "Explaining..." : "Explain with AI"}
              </button>
            </div>

            {/* AI Explanation (if available) */}
            {explanation && (
              <div style={{ padding: 12, background: "var(--app-canvas)", borderBottom: "1px solid var(--border-default)", maxHeight: "300px", overflowY: "auto" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", marginBottom: 8 }}>
                  AI Explanation
                </div>
                <div style={{
                  fontSize: 11,
                  color: "var(--text-primary)",
                  lineHeight: "1.6",
                  whiteSpace: "pre-wrap",
                }}>
                  {explanation}
                </div>
              </div>
            )}

            {/* YANG content */}
            <div style={{ flex: 1, overflowY: "auto", padding: 12, position: "relative" }}>
              {loadingContent ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-secondary)" }}>
                  Loading module content...
                </div>
              ) : (
                <pre
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(moduleContent, `YANG: ${selectedModule?.name}`, e);
                  }}
                  style={{
                    margin: 0,
                    fontSize: 11,
                    fontFamily: "Menlo, monospace",
                    color: "var(--text-primary)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                    userSelect: "text",
                  }}
                >
                  {moduleContent}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Context menu for piping content */}
      <PipeMenu target={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
