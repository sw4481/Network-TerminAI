import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

export function VersionFooter() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then(setVersion).catch(console.error);
  }, []);

  if (!version) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "4px",
        left: "8px",
        fontSize: "10px",
        color: "var(--text-primary)",
        userSelect: "none",
        pointerEvents: "none",
        zIndex: 1000,
      }}
    >
      v{version}
    </div>
  );
}
