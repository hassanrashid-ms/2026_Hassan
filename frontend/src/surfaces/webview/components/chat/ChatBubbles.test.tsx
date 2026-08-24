import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatBubbles } from './ChatBubbles.tsx';
import type { ChatMessage } from '@/features/chat/components/types';

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

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    authorType: 'bot',
    body: 'hello',
    createdAt: '2026-08-18T10:00:00.000Z',
    deliveryState: 'sent',
    ...overrides,
  };
}

function renderBubbles(messages: ChatMessage[]) {
  return render(
    <MemoryRouter initialEntries={['/embed/support/chat']}>
      <ChatBubbles messages={messages} onRetry={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ChatBubbles markdown', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = renderBubbles([message({ body: 'Refunds take **48 hours**.' })]);

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
    expect(container.textContent).not.toContain('**');
  });

  it('renders a player body literally — asterisks stay asterisks', async () => {
    const { container } = renderBubbles([
      message({ authorType: 'player', body: 'my **game** crashed' }),
    ]);

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument());
    expect(container.querySelector('strong')).toBeNull();
  });
});

describe('ChatBubbles read-more', () => {
  it('links to the article when the message cited one', async () => {
    renderBubbles([message({ articleId: 'art-1' })]);

    const link = await screen.findByRole('link', { name: 'Read more' });
    expect(link).toHaveAttribute('href', '/embed/support/chat/articles/art-1');
  });

  it('renders no button when the message cited nothing — every pre-existing message', async () => {
    renderBubbles([message()]);

    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument();
  });

  it('renders no button on a player bubble even if one somehow carried an id', async () => {
    renderBubbles([message({ authorType: 'player', body: 'thanks', articleId: 'art-1' })]);

    await waitFor(() => expect(screen.getByText('thanks')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Read more' })).not.toBeInTheDocument();
  });
});
