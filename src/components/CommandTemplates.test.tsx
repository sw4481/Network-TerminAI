// src/components/CommandTemplates.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandTemplates } from './CommandTemplates';

describe('CommandTemplates', () => {
  it('should render with default category', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Should show header
    expect(screen.getByText('Command Templates')).toBeInTheDocument();

    // Should show category tabs
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('File Operations')).toBeInTheDocument();
    expect(screen.getByText('Process Management')).toBeInTheDocument();
    expect(screen.getByText('System Info')).toBeInTheDocument();
  });

  it('should show templates for selected category', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Default category is Network, should show network templates
    expect(screen.getByText('Ping Host')).toBeInTheDocument();
    expect(screen.getByText('DNS Lookup')).toBeInTheDocument();
  });

  it('should switch categories when clicking tabs', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Click on File Operations tab
    fireEvent.click(screen.getByText('File Operations'));

    // Should show file templates
    expect(screen.getByText('Find Files')).toBeInTheDocument();
    expect(screen.getByText('Search in Files')).toBeInTheDocument();
  });

  it('should call onClose when close button clicked', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Click close button
    const closeButton = screen.getByText('✕');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should call onClose when overlay clicked', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Click overlay
    const overlay = screen.getByText('Command Templates').closest('.templates-overlay');
    if (overlay) {
      fireEvent.click(overlay);
    }

    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose when Escape key pressed', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Press Escape key
    const modal = screen.getByText('Command Templates').closest('.templates-modal');
    if (modal) {
      fireEvent.keyDown(modal.parentElement!, { key: 'Escape' });
    }

    expect(onClose).toHaveBeenCalled();
  });

  it('should show all categories', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Should show all 4 category tabs
    const categoryTabs = screen.getAllByRole('button');
    const categoryNames = categoryTabs
      .filter(btn =>
        btn.textContent === 'Network' ||
        btn.textContent === 'File Operations' ||
        btn.textContent === 'Process Management' ||
        btn.textContent === 'System Info'
      );

    expect(categoryNames.length).toBeGreaterThanOrEqual(4);
  });

  it('should highlight active category tab', () => {
    const onTemplateSelected = vi.fn();
    const onClose = vi.fn();

    render(<CommandTemplates onTemplateSelected={onTemplateSelected} onClose={onClose} />);

    // Default active category is Network
    const networkTab = screen.getByText('Network');
    expect(networkTab.className).toContain('active');
  });
});
