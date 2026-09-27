import { useState } from "react";
import { useSkillsStore, type Skill } from "../state/skillsStore";

type SkillsListProps = {
  onSelectSkill: (skill: Skill) => void;
};

export function SkillsList({ onSelectSkill }: SkillsListProps) {
  const skills = useSkillsStore((s) => s.skills);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredSkills = skills.filter((skill) => {
    const query = searchQuery.toLowerCase();
    return (
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query)
    );
  });

  return (
    <div className="skills-list-container">
      <div className="skills-list-header">
        <div className="search-bar">
          <input
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>
      </div>

      {filteredSkills.length === 0 ? (
        <div className="empty-state">
          <p className="muted">
            {searchQuery
              ? "No skills match your search."
              : "No skills configured."}
          </p>
          {!searchQuery && (
            <p className="muted">
              Skills are loaded from <code>~/.ccie-terminal/skills/</code>
            </p>
          )}
        </div>
      ) : (
        <div className="skills-grid">
          {filteredSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onClick={() => onSelectSkill(skill)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type SkillCardProps = {
  skill: Skill;
  onClick: () => void;
};

function SkillCard({ skill, onClick }: SkillCardProps) {
  return (
    <div className="skill-card" onClick={onClick}>
      <div className="skill-card-header">
        <h3 className="skill-card-name">{skill.name}</h3>
      </div>
      <p className="skill-card-description">{skill.description}</p>
      <div className="skill-card-footer">
        <span className="skill-card-meta">
          {skill.scripts.length} script{skill.scripts.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
