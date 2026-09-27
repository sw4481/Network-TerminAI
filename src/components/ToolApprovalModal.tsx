import { useEffect, useState } from "react";
import { approveToolCall } from "../lib/tauri";

type ToolApprovalModalProps = {
  request: {
    requestId: string;
    server: string;
    tool: string;
    description: string;
    args: Record<string, any>;
  } | null;
  isOpen: boolean;
  onClose: () => void;
};

export function ToolApprovalModal({ request, isOpen, onClose }: ToolApprovalModalProps) {
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleDeny = async () => {
    setLoading(true);
    try {
      await approveToolCall({
        requestId: request!.requestId,
        approved: false,
        remember: false,
      });
      onClose();
    } catch (error) {
      console.error("Failed to deny tool call:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleDeny();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, request?.requestId]);

  if (!isOpen || !request) {
    return null;
  }

  const handleApprove = async () => {
    setLoading(true);
    try {
      await approveToolCall({
        requestId: request.requestId,
        approved: true,
        remember,
      });
      onClose();
    } catch (error) {
      console.error("Failed to approve tool call:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="tool-approval-modal-overlay"
      onClick={() => !loading && handleDeny()}
      data-testid="tool-approval-overlay"
    >
      <div
        className="tool-approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-approval-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tool-approval-header">
          <h2 id="tool-approval-title">Tool Approval Request</h2>
        </div>

        <div className="tool-approval-content">
          <div className="tool-approval-field">
            <label>Server:</label>
            <span className="tool-approval-value">{request.server}</span>
          </div>

          <div className="tool-approval-field">
            <label>Tool:</label>
            <span className="tool-approval-value">{request.tool}</span>
          </div>

          <div className="tool-approval-field">
            <label>Description:</label>
            <p className="tool-approval-description">{request.description}</p>
          </div>

          <div className="tool-approval-field">
            <label>Arguments:</label>
            <pre className="tool-approval-args">
              {JSON.stringify(request.args, null, 2)}
            </pre>
          </div>

          <div className="tool-approval-remember">
            <label>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={loading}
              />
              <span>Always allow this tool for this server</span>
            </label>
          </div>
        </div>

        <div className="tool-approval-actions">
          <button
            className="tool-approval-btn tool-approval-btn-deny"
            onClick={handleDeny}
            disabled={loading}
          >
            Deny
          </button>
          <button
            className="tool-approval-btn tool-approval-btn-approve"
            onClick={handleApprove}
            disabled={loading}
          >
            {loading ? "Processing..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
