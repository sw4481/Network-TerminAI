import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodeBlock } from './CodeBlock';

describe('CodeBlock', () => {
  it('renders collapsed by default', () => {
    render(
      <CodeBlock
        code="print('hello')"
        status="executing"
      />
    );

    // Header should be visible
    expect(screen.getByText(/executing/i)).toBeInTheDocument();

    // Code should not be visible when collapsed
    const codeElement = screen.queryByText("print('hello')");
    expect(codeElement).not.toBeInTheDocument();
  });

  it('shows code when expanded', () => {
    render(
      <CodeBlock
        code="print('hello')"
        collapsed={false}
        status="success"
      />
    );

    // Code should be visible when expanded
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
  });

  it('toggles expand/collapse on click', async () => {
    const user = userEvent.setup();

    render(
      <CodeBlock
        code="print('hello')"
        status="success"
      />
    );

    // Should be collapsed initially
    expect(screen.queryByText("print('hello')")).not.toBeInTheDocument();

    // Click the header
    const header = screen.getByRole('button');
    await user.click(header);

    // Should be expanded now
    expect(screen.getByText("print('hello')")).toBeInTheDocument();

    // Click again to collapse
    await user.click(header);

    // Should be collapsed again
    expect(screen.queryByText("print('hello')")).not.toBeInTheDocument();
  });
});
