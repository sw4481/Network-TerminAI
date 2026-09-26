import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PcapTemplateLibrary } from './PcapTemplateLibrary';
import { createTemplate } from '../lib/pcap';

vi.mock('../lib/pcap', () => ({
  createTemplate: vi.fn(async () => 'tpl-new-id'),
  listTemplates: vi.fn(async () => [
    {
      id: 'tpl-iosxe-wan',
      name: 'IOS-XE WAN any-any',
      vendor: 'cisco',
      platform: 'iosxe',
      interface: '<WAN_IF>',
      acl: null,
      duration_s: 30,
      builtin: true,
    },
    {
      id: 'tpl-junos-ge',
      name: 'Junos monitor traffic ge-0/0/0',
      vendor: 'juniper',
      platform: 'junos',
      interface: 'ge-0/0/0',
      acl: null,
      duration_s: 30,
      builtin: true,
    },
  ]),
  deleteTemplate: vi.fn(),
}));

describe('PcapTemplateLibrary', () => {
  it('lists builtin templates and filters by vendor chip', async () => {
    render(<PcapTemplateLibrary onSelectTemplate={() => {}} selectedId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('pcap-template-tpl-iosxe-wan')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('pcap-template-tpl-junos-ge')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Juniper'));
    expect(
      screen.queryByTestId('pcap-template-tpl-iosxe-wan'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('pcap-template-tpl-junos-ge')).toBeInTheDocument();
  });

  it('search filters by interface text', async () => {
    render(<PcapTemplateLibrary onSelectTemplate={() => {}} selectedId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('pcap-template-tpl-iosxe-wan')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('pcap-template-search'), {
      target: { value: 'ge-0/0/0' },
    });
    expect(
      screen.queryByTestId('pcap-template-tpl-iosxe-wan'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('pcap-template-tpl-junos-ge')).toBeInTheDocument();
  });

  it('clicking a template invokes onSelectTemplate', async () => {
    const onSelect = vi.fn();
    render(
      <PcapTemplateLibrary onSelectTemplate={onSelect} selectedId={null} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('pcap-template-tpl-iosxe-wan')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('pcap-template-tpl-iosxe-wan'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tpl-iosxe-wan', builtin: true }),
    );
  });

  it('creates a new template via the form', async () => {
    render(<PcapTemplateLibrary onSelectTemplate={() => {}} selectedId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('pcap-template-tpl-iosxe-wan')).toBeInTheDocument(),
    );

    // Form is hidden until "+ New" is clicked.
    expect(screen.queryByTestId('pcap-template-form')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pcap-template-new'));
    expect(screen.getByTestId('pcap-template-form')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('pcap-template-form-name'), {
      target: { value: 'My WAN cap' },
    });
    fireEvent.change(screen.getByTestId('pcap-template-form-interface'), {
      target: { value: 'Gi0/0/1' },
    });
    fireEvent.click(screen.getByTestId('pcap-template-save'));

    await waitFor(() =>
      expect(createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My WAN cap',
          interface: 'Gi0/0/1',
          platform: 'iosxe',
          vendor: 'cisco',
          builtin: false,
        }),
      ),
    );
  });

  it('disables save until name and interface are provided', async () => {
    render(<PcapTemplateLibrary onSelectTemplate={() => {}} selectedId={null} />);
    await waitFor(() =>
      expect(screen.getByTestId('pcap-template-tpl-iosxe-wan')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('pcap-template-new'));
    expect(screen.getByTestId('pcap-template-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('pcap-template-form-name'), {
      target: { value: 'Only a name' },
    });
    expect(screen.getByTestId('pcap-template-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('pcap-template-form-interface'), {
      target: { value: 'Gi0/0/1' },
    });
    expect(screen.getByTestId('pcap-template-save')).toBeEnabled();
  });
});
