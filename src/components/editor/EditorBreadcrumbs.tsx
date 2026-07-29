export function breadcrumbSegments(
  filePath: string,
  rootPath: string | null,
): string[] {
  const normalizedRoot = rootPath?.replace(/\/+$/, "") ?? null;
  const relative =
    normalizedRoot &&
    (filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`))
      ? filePath.slice(normalizedRoot.length)
      : filePath;

  return relative.split("/").filter(Boolean);
}

export function EditorBreadcrumbs({
  filePath,
  rootPath,
}: {
  filePath: string;
  rootPath: string | null;
}) {
  const segments = breadcrumbSegments(filePath, rootPath);

  return (
    <nav className="editor-breadcrumb" aria-label="Editor breadcrumb">
      {segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        return (
          <span className="editor-breadcrumb-part" key={`${segment}-${index}`}>
            {index > 0 && <span className="editor-breadcrumb-separator">›</span>}
            <span aria-current={isLast ? "page" : undefined}>{segment}</span>
          </span>
        );
      })}
    </nav>
  );
}
