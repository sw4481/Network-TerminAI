import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorAnalysis } from './ErrorAnalysis';

describe('ErrorAnalysis', () => {
  it('renders error analysis with explanation and suggestions', () => {
    const onExecuteSuggestion = vi.fn();
    const analysis = {
      errorType: 'command_not_found',
      explanation: 'The command "gitx" was not found in your PATH.',
      suggestions: [
        'git status',
        'git log',
        'Install gitx via: brew install gitx',
      ],
    };

    render(
      <ErrorAnalysis
        analysis={analysis}
        loading={false}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    expect(screen.getByText('Error Analysis')).toBeInTheDocument();
    expect(screen.getByText(analysis.explanation)).toBeInTheDocument();
    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.getByText('git log')).toBeInTheDocument();
  });

  it('shows loading state with spinner', () => {
    const onExecuteSuggestion = vi.fn();

    render(
      <ErrorAnalysis
        analysis={null}
        loading={true}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    expect(screen.getByText('Analyzing error...')).toBeInTheDocument();
    expect(screen.getByText('⏳')).toBeInTheDocument();
  });

  it('calls onExecuteSuggestion when suggestion clicked', () => {
    const onExecuteSuggestion = vi.fn();
    const analysis = {
      errorType: 'permission_denied',
      explanation: 'Permission denied accessing the file.',
      suggestions: [
        'sudo cat /etc/hosts',
        'chmod +r /etc/hosts',
      ],
    };

    render(
      <ErrorAnalysis
        analysis={analysis}
        loading={false}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    const firstSuggestion = screen.getByText('sudo cat /etc/hosts');
    fireEvent.click(firstSuggestion);

    expect(onExecuteSuggestion).toHaveBeenCalledWith('sudo cat /etc/hosts');
  });

  it('renders with red error theme', () => {
    const onExecuteSuggestion = vi.fn();
    const analysis = {
      errorType: 'syntax_error',
      explanation: 'Invalid syntax in command.',
      suggestions: ['ls -la', 'ls -l'],
    };

    const { container } = render(
      <ErrorAnalysis
        analysis={analysis}
        loading={false}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    const errorAnalysis = container.querySelector('.error-analysis');
    expect(errorAnalysis).toBeInTheDocument();
    expect(errorAnalysis).toHaveClass('error-analysis');
  });

  it('shows error message when analysis fails', () => {
    const onExecuteSuggestion = vi.fn();

    render(
      <ErrorAnalysis
        analysis={null}
        loading={false}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    expect(screen.getByText('Failed to analyze error.')).toBeInTheDocument();
  });

  it('limits suggestions to 3 items', () => {
    const onExecuteSuggestion = vi.fn();
    const analysis = {
      errorType: 'unknown',
      explanation: 'Something went wrong.',
      suggestions: [
        'suggestion 1',
        'suggestion 2',
        'suggestion 3',
        'suggestion 4',
        'suggestion 5',
      ],
    };

    render(
      <ErrorAnalysis
        analysis={analysis}
        loading={false}
        onExecuteSuggestion={onExecuteSuggestion}
      />
    );

    // Should only show first 3 suggestions
    expect(screen.getByText('suggestion 1')).toBeInTheDocument();
    expect(screen.getByText('suggestion 2')).toBeInTheDocument();
    expect(screen.getByText('suggestion 3')).toBeInTheDocument();
    expect(screen.queryByText('suggestion 4')).not.toBeInTheDocument();
  });
});
