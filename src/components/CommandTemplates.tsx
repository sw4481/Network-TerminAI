// src/components/CommandTemplates.tsx
// Command templates browser modal with category tabs

import { memo, useState } from 'react';
import { getTemplatesByCategory, getCategoryName, fillTemplate, CommandTemplate } from '../lib/templates';
import './CommandTemplates.css';

interface CommandTemplatesProps {
  onTemplateSelected: (command: string) => void;
  onClose: () => void;
}

type Category = CommandTemplate['category'];

const CATEGORIES: Category[] = ['network', 'file', 'process', 'system'];

export const CommandTemplates = memo(function CommandTemplates({
  onTemplateSelected,
  onClose,
}: CommandTemplatesProps) {
  const [selectedCategory, setSelectedCategory] = useState<Category>('network');

  const handleTemplateClick = (template: CommandTemplate) => {
    // If template has parameters, prompt for them
    if (template.parameters && template.parameters.length > 0) {
      const values: Record<string, string> = {};

      // Prompt for each parameter
      for (const param of template.parameters) {
        const value = prompt(`Enter value for ${param}:`);
        if (value === null) {
          // User cancelled
          return;
        }
        values[param] = value;
      }

      // Fill template with values
      const command = fillTemplate(template.template, values);
      onTemplateSelected(command);
    } else {
      // No parameters, use template as-is
      onTemplateSelected(template.template);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const templatesInCategory = getTemplatesByCategory(selectedCategory);

  return (
    <div className="templates-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="templates-modal" onClick={(e) => e.stopPropagation()}>
        <div className="templates-header">
          <h3>Command Templates</h3>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="templates-content">
          {/* Category tabs */}
          <div className="templates-categories">
            {CATEGORIES.map((category) => (
              <button
                key={category}
                className={`category-tab ${selectedCategory === category ? 'active' : ''}`}
                onClick={() => setSelectedCategory(category)}
              >
                {getCategoryName(category)}
              </button>
            ))}
          </div>

          {/* Template list */}
          <div className="templates-list">
            {templatesInCategory.map((template) => (
              <button
                key={template.id}
                className="template-item"
                onClick={() => handleTemplateClick(template)}
              >
                <div className="template-name">{template.name}</div>
                <div className="template-command">{template.template}</div>
                <div className="template-description">{template.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="templates-footer">
          <div className="templates-hint">
            Click a template to use it. Templates with parameters will prompt for values.
          </div>
        </div>
      </div>
    </div>
  );
});
