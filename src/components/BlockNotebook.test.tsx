import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BlockNotebook } from './BlockNotebook';

describe('BlockNotebook', () => {
  it('renders save and load tabs', () => {
    const onSave = vi.fn();
    const onLoad = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockNotebook
        onSave={onSave}
        onLoad={onLoad}
        onClose={onClose}
      />
    );

    // Check tabs exist (look in the tabs container)
    expect(screen.getByRole('button', { name: /^Save Notebook$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Load Notebook$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Saved Notebooks$/ })).toBeInTheDocument();
  });

  it('save tab shows name and description inputs', () => {
    const onSave = vi.fn();
    const onLoad = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockNotebook
        onSave={onSave}
        onLoad={onLoad}
        onClose={onClose}
      />
    );

    // Save tab should be active by default
    expect(screen.getByPlaceholderText(/notebook name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/description/i)).toBeInTheDocument();
  });

  it('calls onSave with name and description', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onLoad = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockNotebook
        onSave={onSave}
        onLoad={onLoad}
        onClose={onClose}
      />
    );

    // Fill in form
    const nameInput = screen.getByPlaceholderText(/notebook name/i);
    const descInput = screen.getByPlaceholderText(/description/i);

    await user.type(nameInput, 'Test Session');
    await user.type(descInput, 'A test session description');

    // Submit
    const saveButton = screen.getByRole('button', { name: /^Save$/ });
    await user.click(saveButton);

    // Check callback
    expect(onSave).toHaveBeenCalledWith('Test Session', 'A test session description');
  });

  it('load tab shows file upload', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onLoad = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockNotebook
        onSave={onSave}
        onLoad={onLoad}
        onClose={onClose}
      />
    );

    // Switch to Load tab
    const loadTab = screen.getByText('Load Notebook');
    await user.click(loadTab);

    // Check for file input
    expect(screen.getByText(/choose a .ccienb file/i)).toBeInTheDocument();
  });
});
