import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateHeartbeatModal } from './CreateHeartbeatModal';
import * as tauri from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  planHeartbeat: vi.fn(),
  createHeartbeat: vi.fn(),
}));

describe('CreateHeartbeatModal', () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Stage 1: Natural Language Input', () => {
    it('renders input stage with textarea and examples', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      expect(screen.getByText('Create Heartbeat')).toBeInTheDocument();
      expect(screen.getByLabelText(/describe what you want to monitor/i)).toBeInTheDocument();
      expect(screen.getByText(/Check for critical issues on my Meraki network/i)).toBeInTheDocument();
      expect(screen.getByText(/Verify all pyATS devices are reachable/i)).toBeInTheDocument();
      expect(screen.getByText(/Monitor Stealthwatch for security events/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /analyze/i })).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      const { container } = render(
        <CreateHeartbeatModal
          isOpen={false}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('populates textarea when example is clicked', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const exampleButton = screen.getByText(/Check for critical issues on my Meraki network/i);
      fireEvent.click(exampleButton);

      const textarea = screen.getByLabelText(/describe what you want to monitor/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain('Meraki network');
    });

    it('shows error when analyze is clicked with empty input', async () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const analyzeButton = screen.getByRole('button', { name: /analyze/i });
      fireEvent.click(analyzeButton);

      await waitFor(() => {
        expect(screen.getByText(/please enter a description/i)).toBeInTheDocument();
      });

      expect(tauri.planHeartbeat).not.toHaveBeenCalled();
    });

    it('calls planHeartbeat and transitions to Stage 2 on success', async () => {
      const mockPlan = {
        status: 'success' as const,
        plan: {
          name: 'Meraki Health Check',
          description: 'Monitors meraki every 30 minutes',
          interval_minutes: 30,
          checks: [
            {
              check_group_name: 'Meraki',
              agent_id: 'meraki',
              agent_prompt: 'Check Meraki network health',
              sort_order: 0,
            },
          ],
        },
        error: null,
      };

      vi.mocked(tauri.planHeartbeat).mockResolvedValue(mockPlan);

      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const textarea = screen.getByLabelText(/describe what you want to monitor/i);
      fireEvent.change(textarea, { target: { value: 'Check my Meraki network every 30 minutes' } });

      const analyzeButton = screen.getByRole('button', { name: /analyze/i });
      fireEvent.click(analyzeButton);

      await waitFor(() => {
        expect(screen.getByText('Review & Edit Plan')).toBeInTheDocument();
      });

      expect(tauri.planHeartbeat).toHaveBeenCalledWith('Check my Meraki network every 30 minutes');
      expect(screen.getByDisplayValue('Meraki Health Check')).toBeInTheDocument();
    });

    it('shows error when planHeartbeat returns error', async () => {
      const mockError = {
        status: 'error' as const,
        plan: null,
        error: 'Could not identify systems to monitor',
      };

      vi.mocked(tauri.planHeartbeat).mockResolvedValue(mockError);

      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const textarea = screen.getByLabelText(/describe what you want to monitor/i);
      fireEvent.change(textarea, { target: { value: 'check something vague' } });

      const analyzeButton = screen.getByRole('button', { name: /analyze/i });
      fireEvent.click(analyzeButton);

      await waitFor(() => {
        expect(screen.getByText(/Could not identify systems to monitor/i)).toBeInTheDocument();
      });

      expect(screen.queryByText('Review & Edit Plan')).not.toBeInTheDocument();
    });
  });

  describe('Stage 2: Plan Review & Edit', () => {
    const setupStage2 = async () => {
      const mockPlan = {
        status: 'success' as const,
        plan: {
          name: 'Multi-Agent Check',
          description: 'Monitors meraki, ise every 60 minutes',
          interval_minutes: 60,
          checks: [
            {
              check_group_name: 'Meraki',
              agent_id: 'meraki',
              agent_prompt: 'Check Meraki health',
              sort_order: 0,
            },
            {
              check_group_name: 'ISE',
              agent_id: 'ise',
              agent_prompt: 'Check ISE authentication',
              sort_order: 1,
            },
          ],
        },
        error: null,
      };

      vi.mocked(tauri.planHeartbeat).mockResolvedValue(mockPlan);

      const result = render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const textarea = screen.getByLabelText(/describe what you want to monitor/i);
      fireEvent.change(textarea, { target: { value: 'Check Meraki and ISE every hour' } });

      const analyzeButton = screen.getByRole('button', { name: /analyze/i });
      fireEvent.click(analyzeButton);

      await waitFor(() => {
        expect(screen.getByText('Review & Edit Plan')).toBeInTheDocument();
      });

      return result;
    };

    it('renders all plan fields as editable', async () => {
      await setupStage2();

      expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^description/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^interval/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/retention/i)).toBeInTheDocument();
      expect(screen.getByText(/checks \(2\)/i)).toBeInTheDocument();
    });

    it('converts interval to appropriate units', async () => {
      await setupStage2();

      const intervalInput = screen.getByLabelText(/^interval/i) as HTMLInputElement;
      expect(intervalInput.value).toBe('1');

      const unitSelect = screen.getByDisplayValue('hours');
      expect(unitSelect).toBeInTheDocument();
    });

    it('renders all checks with editable fields', async () => {
      await setupStage2();

      expect(screen.getByDisplayValue('Meraki')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ISE')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Check Meraki health')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Check ISE authentication')).toBeInTheDocument();
    });

    it('adds a new check when Add Check button is clicked', async () => {
      await setupStage2();

      const addButton = screen.getByRole('button', { name: /add check/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/checks \(3\)/i)).toBeInTheDocument();
      });
    });

    it('removes a check when remove button is clicked', async () => {
      await setupStage2();

      const removeButtons = screen.getAllByTitle('Remove check');
      fireEvent.click(removeButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/checks \(1\)/i)).toBeInTheDocument();
      });

      expect(screen.queryByDisplayValue('Check Meraki health')).not.toBeInTheDocument();
    });

    it('updates check fields when edited', async () => {
      await setupStage2();

      const groupNameInput = screen.getByDisplayValue('Meraki') as HTMLInputElement;
      fireEvent.change(groupNameInput, { target: { value: 'Updated Meraki' } });

      expect(groupNameInput.value).toBe('Updated Meraki');
    });

    it('calls createHeartbeat with all data on create', async () => {
      vi.mocked(tauri.createHeartbeat).mockResolvedValue({} as any);

      await setupStage2();

      const createButton = screen.getByRole('button', { name: /create heartbeat/i });
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(tauri.createHeartbeat).toHaveBeenCalled();
      });

      const [name, description, intervalMinutes, retentionDays, checks] = vi.mocked(tauri.createHeartbeat).mock.calls[0];

      expect(name).toBe('Multi-Agent Check');
      expect(description).toBe('Monitors meraki, ise every 60 minutes');
      expect(intervalMinutes).toBe(60); // 1 hour in minutes
      expect(retentionDays).toBe(30);
      expect(checks).toHaveLength(2);
      expect(checks[0].agentId).toBe('meraki');
      expect(checks[1].agentId).toBe('ise');
    });

    it('shows error when name is empty', async () => {
      await setupStage2();

      const nameInput = screen.getByLabelText(/^name/i);
      fireEvent.change(nameInput, { target: { value: '' } });

      const createButton = screen.getByRole('button', { name: /create heartbeat/i });
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      });

      expect(tauri.createHeartbeat).not.toHaveBeenCalled();
    });

    it('shows success message and calls onSuccess after creation', async () => {
      vi.mocked(tauri.createHeartbeat).mockResolvedValue({} as any);

      await setupStage2();

      const createButton = screen.getByRole('button', { name: /create heartbeat/i });
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByText(/heartbeat created successfully/i)).toBeInTheDocument();
      });

      // Wait for auto-close
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      }, { timeout: 2000 });
    });

    it('returns to Stage 1 when Back button is clicked', async () => {
      await setupStage2();

      const backButton = screen.getByRole('button', { name: /back/i });
      fireEvent.click(backButton);

      await waitFor(() => {
        expect(screen.getByText('Create Heartbeat')).toBeInTheDocument();
        expect(screen.queryByText('Review & Edit Plan')).not.toBeInTheDocument();
      });
    });
  });

  describe('Modal controls', () => {
    it('calls onClose when close button is clicked', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const closeButton = screen.getByRole('button', { name: '✕' });
      fireEvent.click(closeButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onClose when Cancel button is clicked', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('calls onClose when overlay is clicked', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const overlay = screen.getByText('Create Heartbeat').closest('.modal-overlay');
      if (overlay) {
        fireEvent.click(overlay);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });

    it('does not close when modal content is clicked', () => {
      render(
        <CreateHeartbeatModal
          isOpen={true}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />
      );

      const modalContent = screen.getByText('Create Heartbeat').closest('.modal-content');
      if (modalContent) {
        fireEvent.click(modalContent);
        expect(mockOnClose).not.toHaveBeenCalled();
      }
    });
  });
});
