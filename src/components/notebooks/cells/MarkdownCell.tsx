import ReactMarkdown from "react-markdown";

interface Props {
  content: string;
}

export function MarkdownCell({ content }: Props) {
  return (
    <div className="notebook-cell markdown-cell" data-testid="cell-markdown">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
