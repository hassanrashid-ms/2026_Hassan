import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDetail } from '@support/types';
import { FormEditorSheet } from './FormEditorSheet.tsx';
import * as agentApi from '../../../api/agentApi.ts';
import type { StoredAgentSession } from '../../../lib/agentSession.ts';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const ADMIN_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'admin',
};
const TEAM_LEAD_SESSION: StoredAgentSession = {
  token: 't',
  agentId: 'a1',
  displayName: 'A',
  workspaceSlug: 'ws',
  role: 'team_lead',
};

const FORM_WITH_DRAFT: FormDetail = {
  id: 'form-1',
  name: 'Refund request',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  draft: {
    version: 2,
    fields: [
      { key: 'order_id', label: 'Order ID', type: 'short_text', isRequired: true, position: 0 },
    ],
    publishedAt: null,
  },
  published: { version: 1, fields: [], publishedAt: '2026-01-01T00:00:00Z' },
  subintents: [{ id: 'sub-1', name: 'Refund', intentId: 'int-1' }],
};

const FORM_WITH_EMPTY_DRAFT: FormDetail = {
  id: 'form-2',
  name: 'Empty draft form',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  draft: { version: 1, fields: [], publishedAt: null },
  published: null,
  subintents: [],
};

const INTENTS = {
  intents: [
    {
      id: 'int-1',
      name: 'Billing',
      isSystem: false,
      archivedAt: null,
      subintents: [
        {
          id: 'sub-1',
          name: 'Refund',
          formId: 'form-1',
          archivedAt: null,
          defaultPriority: null,
          mergedIntoId: null,
        },
        {
          id: 'sub-2',
          name: 'Chargeback',
          formId: null,
          archivedAt: null,
          defaultPriority: null,
          mergedIntoId: null,
        },
      ],
    },
  ],
};

describe('FormEditorSheet — new form save', () => {
  it('creates the form then sets its subintent mapping', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    const createSpy = vi
      .spyOn(agentApi, 'createForm')
      .mockResolvedValue({ id: 'new-form', draftVersionId: 'v1' });
    const setSubintentsSpy = vi
      .spyOn(agentApi, 'setFormSubintents')
      .mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId={null}
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByPlaceholderText('Form name');
    await userEvent.type(screen.getByPlaceholderText('Form name'), 'New form');
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-intents' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Chargeback' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create Form' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith('t', 'New form'));
    await waitFor(() => expect(setSubintentsSpy).toHaveBeenCalledWith('t', 'new-form', ['sub-2']));
  });
});

describe('FormEditorSheet — existing form save', () => {
  it('updates the form and its subintent mapping', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_DRAFT);
    const updateSpy = vi.spyOn(agentApi, 'updateForm').mockResolvedValue(FORM_WITH_DRAFT);
    const setSubintentsSpy = vi
      .spyOn(agentApi, 'setFormSubintents')
      .mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId="form-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refund request');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        't',
        'form-1',
        expect.objectContaining({ name: 'Refund request' }),
      ),
    );
    await waitFor(() => expect(setSubintentsSpy).toHaveBeenCalledWith('t', 'form-1', ['sub-1']));
  });
});

describe('FormEditorSheet — publish visibility', () => {
  it('hides Publish for a non-admin Team Lead', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={TEAM_LEAD_SESSION}
        formId="form-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refund request');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('disables Publish for an admin when the draft has zero fields', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_EMPTY_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId="form-2"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Empty draft form');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('enables Publish for an admin with a non-empty draft', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId="form-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refund request');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });
});

describe('FormEditorSheet — live preview', () => {
  it('shows a live mobile preview of the current draft that updates as fields change', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);
    vi.spyOn(agentApi, 'fetchForm').mockResolvedValue(FORM_WITH_DRAFT);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId="form-1"
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByDisplayValue('Refund request');
    const panel = within(screen.getByTestId('form-live-preview-panel'));
    expect(panel.getByText('Order ID')).toBeInTheDocument();

    await userEvent.type(screen.getByDisplayValue('Order ID'), ' updated');
    expect(panel.getByText('Order ID updated')).toBeInTheDocument();
  });
});

describe('FormEditorSheet — field type picker', () => {
  it('offers the six builder types, including attachment, never time', async () => {
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue(INTENTS);

    renderWithClient(
      <FormEditorSheet
        token="t"
        session={ADMIN_SESSION}
        formId={null}
        open
        onOpenChange={() => {}}
        onCreated={() => {}}
      />,
    );

    await screen.findByPlaceholderText('Form name');
    await userEvent.click(screen.getByRole('button', { name: '+ Add a field' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Short text' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Long text' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Number' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Date' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Choice' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /attachment/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^time$/i })).not.toBeInTheDocument();
  });
});
