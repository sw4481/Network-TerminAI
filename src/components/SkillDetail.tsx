import ReactMarkdown from "react-markdown";
import { type Skill } from "../state/skillsStore";

type SkillDetailProps = {
  skill: Skill;
  onClose: () => void;
};

export function SkillDetail({ skill, onClose }: SkillDetailProps) {
  const handleCopyPath = () => {
    navigator.clipboard.writeText(skill.path);
  };

  return (
    <div className="skill-detail-overlay" onClick={onClose}>
      <div className="skill-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="skill-detail-header">
          <h2>{skill.name}</h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="skill-detail-content">
          <div className="skill-section">
            <h3>Description</h3>
            <p>{skill.description}</p>
          </div>

          <div className="skill-section">
            <h3>When to Use</h3>
            <div className="skill-when-to-use">
              <ReactMarkdown>{skill.when_to_use}</ReactMarkdown>
            </div>
          </div>

          {skill.body && (
            <div className="skill-section">
              <h3>Playbook</h3>
              <div className="skill-playbook">
                <ReactMarkdown>{skill.body}</ReactMarkdown>
              </div>
            </div>
          )}

          {skill.scripts.length > 0 && (
            <div className="skill-section">
              <h3>Scripts</h3>
              <div className="skill-scripts">
                {skill.scripts.map((scriptPath: string, idx: number) => (
                  <div key={idx} className="script-item">
                    <code className="script-path">{scriptPath}</code>
                  </div>
                ))}
              </div>
            </div>
          )}

          {skill.allowed_commands.length > 0 && (
            <div className="skill-section">
              <h3>Allowed Commands</h3>
              <div className="skill-allowed-commands">
                {skill.allowed_commands.map((cmd: string, idx: number) => (
                  <code key={idx} className="allowed-command">
                    {cmd}
                  </code>
                ))}
              </div>
            </div>
          )}

          <div className="skill-metadata">
            <div className="metadata-row">
              <span className="label">Skill ID:</span>
              <code>{skill.id}</code>
            </div>
            <div className="metadata-row">
              <span className="label">Path:</span>
              <code className="skill-path">{skill.path}</code>
            </div>
          </div>
        </div>

        <div className="skill-detail-footer">
          <button onClick={handleCopyPath} className="secondary">
            Copy Path
          </button>
          <button onClick={onClose} className="primary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
