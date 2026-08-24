import type { ComponentProps } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentMessageView } from '@support/types';
import { ThreadPanel } from './ThreadPanel.tsx';
import {
  detachTag,
  escalateConversation,
  fetchConversationContext,
  fetchConversationMessages,
  markAgentMessagesRead,
  putFileToUploadUrl,
  requestUpload,
  sendAgentMessage,
} from '../../../api/agentApi.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';

vi.mock('../../../api/agentApi.ts');
vi.mock('../../../../../features/chat/api/socket.ts');

// Same stubs ChatThread.test.tsx needs: jsdom lays out nothing, so without them
// Virtuoso measures a zero-height viewport and mounts no items at all.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Element.prototype.getBoundingClientRect = () =>
    ({
      width: 600,
      height: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  globalThis.ResizeObserver = class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function agentMessage(overrides: Partial<AgentMessageView> = {}): AgentMessageView {
  return {
    id: 'm1',
    seq: 1,
    author_type: 'agent',
    author_agent_id: 'a1',
    body: 'HEY!',
    visibility: 'public',
    delivery_state: 'sent',
    read_at: null,
    created_at: '2026-08-13T11:58:48.140Z',
    article_id: null,
    ...overrides,
  } as AgentMessageView;
}

/** Captures the handlers ThreadPanel registers so a test can fire a server event. */
function fakeSocket() {
  const handlers: Record<string, (payload?: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers[event] = handler;
    },
    emit: vi.fn(),
    close: vi.fn(),
  };
  vi.mocked(createSocket).mockReturnValue(socket as never);
  return handlers;
}

type PanelProps = Partial<ComponentProps<typeof ThreadPanel>>;

function renderPanel(overrides: PanelProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadPanel
        token="t"
        conversationId="c1"
        playerExternalId="p-1"
        status="open"
        confirmPhase="none"
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

/** The read-only case: an older ticket resolved by a named agent. */
const RESOLVED: PanelProps = {
  status: 'resolved',
  readOnly: true,
  ticketNumber: 1039,
  resolutionSource: 'agent',
  resolvedByAgentName: 'Sam',
  openedAt: '2026-06-02T09:00:00.000Z',
};

function conversationContext(overrides: Record<string, unknown> = {}) {
  return {
    player_state: { status: 'no_session' },
    tickets: [],
    summary: { total_tickets: 0, total_reopened: 0, first_contact_at: '2026-06-02T09:00:00.000Z' },
    form: null,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(markAgentMessagesRead).mockResolvedValue({ ok: true } as never);
  vi.mocked(fetchConversationContext).mockResolvedValue(conversationContext() as never);
});

describe('ThreadPanel room membership', () => {
  it('joins the conversation room on every connect, not once at setup', async () => {
    const handlers = fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel();
    await screen.findByText('Sent');
    const socket = vi.mocked(createSocket).mock.results[0]!.value as {
      emit: ReturnType<typeof vi.fn>;
    };

    handlers['connect']?.();
    expect(socket.emit).toHaveBeenCalledWith('join_conversation', { conversation_id: 'c1' });

    // A reconnect gets its own socket instance server-side, which has joined
    // nothing — so the client has to ask again or the panel goes silent.
    socket.emit.mockClear();
    handlers['connect']?.();
    expect(socket.emit).toHaveBeenCalledWith('join_conversation', { conversation_id: 'c1' });
  });
});

describe('ThreadPanel optimistic sends', () => {
  it('shows the message as Sending… immediately, before the server answers', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    // Never settles: this is the whole window the agent used to stare at nothing.
    vi.mocked(sendAgentMessage).mockReturnValue(new Promise(() => {}) as never);

    renderPanel();
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'on my way');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('on my way')).toBeInTheDocument();
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  // The repeated-text case (sending "hi" into a thread that already contains
  // "hi") can't be asserted at this level: the jsdom stubs give every bubble the
  // full 600px viewport height, so Virtuoso mounts exactly one item and a second
  // bubble is never in the DOM to find. That rule is covered directly in
  // chatReconcile.test.ts instead.

  it('offers a retry when the send fails instead of losing what was typed', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(sendAgentMessage).mockRejectedValue(new Error('network'));

    renderPanel();
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'still here?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Failed to send.')).toBeInTheDocument();
    expect(screen.getByText('still here?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('drops the optimistic bubble once the refetched thread contains it', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(sendAgentMessage).mockImplementation(async () => {
      // What the server now returns for this send, from the next refetch on.
      vi.mocked(fetchConversationMessages).mockResolvedValue({
        messages: [agentMessage({ body: 'landed', delivery_state: 'sent' })],
      } as never);
      return { message: agentMessage({ body: 'landed' }) } as never;
    });

    renderPanel();
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'landed');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Exactly one bubble survives — the optimistic one must not linger beside
    // the real message.
    await waitFor(() => expect(screen.queryByText('Sending…')).not.toBeInTheDocument());
    expect(screen.getAllByText('landed')).toHaveLength(1);
  });

  it('sends an attachment through the composer', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(requestUpload).mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      upload_url: 'https://example.test/put',
      expires_at: new Date().toISOString(),
    });
    vi.mocked(putFileToUploadUrl).mockResolvedValue(undefined);
    vi.mocked(sendAgentMessage).mockResolvedValue({
      message: {
        id: 'm1',
        seq: 1,
        author_type: 'agent',
        author_name: 'Agent',
        author_agent_id: 'a1',
        body: 'shot.png',
        visibility: 'public',
        delivery_state: 'sent',
        read_at: null,
        created_at: new Date().toISOString(),
        article_id: null,
        attachment: { id: 'att1', filename: 'shot.png', mime_type: 'image/png', byte_size: 3, url: null },
      },
    } as never);

    renderPanel();
    await screen.findByLabelText('Message');

    fireEvent.change(screen.getByLabelText('Attach image'), {
      target: { files: [new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' })] },
    });
    await screen.findByAltText('shot.png');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    // 'public', not undefined: ThreadPanel's Composer always passes
    // allowVisibilityToggle, so the Composer's default visibility state
    // ('public') is what onSend carries, unlike the bare-Composer unit test
    // in Composer.test.tsx which omits the toggle entirely.
    await waitFor(() =>
      expect(sendAgentMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        '',
        'public',
        { key: 'pending/ws/agent/uuid.png', filename: 'shot.png', mimeType: 'image/png', byteSize: 3 },
      ),
    );
  });
});

describe('ThreadPanel read-only tickets', () => {
  it('disables the composer and names the resolver in its placeholder', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel(RESOLVED);

    const input = await screen.findByLabelText('Message');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Resolved by Sam');
  });

  it('says the bot resolved it when there is no agent name', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({ ...RESOLVED, resolutionSource: 'bot', resolvedByAgentName: null });

    expect(await screen.findByLabelText('Message')).toHaveAttribute(
      'placeholder',
      'Resolved by the bot',
    );
  });

  it('falls back to Closed when no resolution source is recorded', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({
      ...RESOLVED,
      status: 'closed',
      resolutionSource: null,
      resolvedByAgentName: null,
    });

    expect(await screen.findByLabelText('Message')).toHaveAttribute('placeholder', 'Closed');
  });

  it('hides "Ask if resolved" entirely rather than disabling it', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel(RESOLVED);
    await screen.findByLabelText('Message');

    expect(screen.queryByRole('button', { name: 'Ask if resolved' })).not.toBeInTheDocument();
  });

  it('banners which ticket is on screen, so the transcript is not mistaken for the live one', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel(RESOLVED);

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Viewing an earlier ticket');
    expect(banner).toHaveTextContent('#1039');
    expect(banner).toHaveTextContent('resolved');
  });

  // The one that matters: read_at is set once and never rewritten, so a glance
  // at an old ticket must not stamp receipts the player is shown.
  it('does not call markAgentMessagesRead', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel(RESOLVED);
    await screen.findByText('Sent');

    expect(markAgentMessagesRead).not.toHaveBeenCalled();
  });

  it('still marks read on a live ticket', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel();
    await screen.findByText('Sent');

    await waitFor(() => expect(markAgentMessagesRead).toHaveBeenCalledWith('t', 'c1', 1));
  });
});

describe('ThreadPanel escalation', () => {
  it('escalates an open conversation without leaving the ticket', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);
    vi.mocked(escalateConversation).mockResolvedValue({ escalated: true } as never);

    renderPanel({ status: 'open' });
    await screen.findByText('Sent');

    await userEvent.click(screen.getByRole('button', { name: 'Escalate' }));

    expect(escalateConversation).toHaveBeenCalledWith('t', 'c1');
  });

  // Escalated is a forward-only state now: there is no Un-escalate button anywhere, and the only
  // way out is resolving, so "Ask if resolved" must still be offered while escalated.
  it('hides Escalate but keeps Ask if resolved offered once a conversation is escalated', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({ status: 'escalated' });
    await screen.findByText('Sent');

    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Un-escalate' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask if resolved' })).toBeEnabled();
  });

  it('hides the escalate button on a read-only ticket', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel(RESOLVED);
    await screen.findByLabelText('Message');

    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Un-escalate' })).not.toBeInTheDocument();
  });

  it('hides the escalate button while the conversation is bot_active', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({ status: 'bot_active' });
    await screen.findByText('Sent');

    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Un-escalate' })).not.toBeInTheDocument();
  });
});

describe('ThreadPanel rail toggle', () => {
  it('exposes a labelled toggle whose pressed state tracks the rail', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);
    const onToggleRail = vi.fn();

    renderPanel({ onToggleRail, railOpen: false });

    const toggle = await screen.findByRole('button', { name: 'Player context' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(onToggleRail).toHaveBeenCalled();
  });
});

describe('ThreadPanel read receipts', () => {
  it("shows one tick until the player has read the agent's message", async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel();
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText('Seen')).not.toBeInTheDocument();
  });

  it('flips to two ticks when the player read receipt arrives over the socket', async () => {
    const handlers = fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel();
    await screen.findByText('Sent');

    // What the server actually emits — verified end to end against a live
    // agent socket — and the refetch it is supposed to drive.
    vi.mocked(fetchConversationMessages).mockResolvedValue({
      messages: [agentMessage({ delivery_state: 'read', read_at: '2026-08-13T12:01:56.658Z' })],
    } as never);
    handlers['message:read']?.({ conversation_id: 'c1', up_to_seq: 1, reader_type: 'player' });

    expect(await screen.findByText('Seen')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Sent')).not.toBeInTheDocument());
  });

  it('carries article_id from the wire through to a Read more link', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({
      messages: [
        agentMessage({ author_type: 'bot', body: 'Refunds take 48 hours.', article_id: 'art-1' }),
      ],
    } as never);

    renderPanel();

    const link = await screen.findByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', '/articles/art-1');
  });
});

describe('ThreadPanel tags and subintent', () => {
  it('renders the subintent badge from the context query, with no dedicated fetch', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(fetchConversationContext).mockResolvedValue(
      conversationContext({
        tickets: [
          {
            id: 'c1',
            number: 1,
            created_at: '2026-08-13T11:00:00.000Z',
            status: 'open',
            subintent: { intent_name: 'Billing', subintent_name: 'Refund' },
            resolution_source: null,
            resolved_by_agent_name: null,
            reopen_count: 0,
          },
        ],
      }) as never,
    );

    renderPanel();

    expect(await screen.findByText('Billing · Refund')).toBeInTheDocument();
    expect(fetchConversationContext).toHaveBeenCalledTimes(1);
  });

  it('renders one badge per attached tag', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(fetchConversationContext).mockResolvedValue(
      conversationContext({
        tags: [
          { id: 'tag-1', name: 'Billing', colorIndex: 0 },
          { id: 'tag-2', name: 'Bug', colorIndex: 1 },
        ],
      }) as never,
    );

    renderPanel();

    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Bug')).toBeInTheDocument();
  });

  it('detaches a tag when its badge × is clicked', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(fetchConversationContext).mockResolvedValue(
      conversationContext({ tags: [{ id: 'tag-1', name: 'Billing', colorIndex: 0 }] }) as never,
    );
    vi.mocked(detachTag).mockResolvedValue({ ok: true } as never);

    renderPanel();
    await screen.findByText('Billing');

    await userEvent.click(screen.getByRole('button', { name: 'Remove tag' }));

    await waitFor(() => expect(detachTag).toHaveBeenCalledWith('t', 'c1', 'tag-1'));
  });

  it('gives the same tag id the same badge color across remounts', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(fetchConversationContext).mockResolvedValue(
      conversationContext({ tags: [{ id: 'tag-1', name: 'Billing', colorIndex: 3 }] }) as never,
    );

    const first = renderPanel();
    const firstBadge = await first.findByText('Billing');
    const firstClassName = firstBadge.closest('span')?.className;
    first.unmount();

    const second = renderPanel();
    const secondBadge = await second.findByText('Billing');
    const secondClassName = secondBadge.closest('span')?.className;

    expect(secondClassName).toBe(firstClassName);
  });
});
