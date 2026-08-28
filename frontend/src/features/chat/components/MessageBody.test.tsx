import { Suspense } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MessageBody } from './MessageBody.tsx';

const MARKDOWN = 'Refunds take **48 hours**.\n\n1. Open Settings\n2. Tap Support';

/** The boundary belongs to the thread in real callers; a test supplies its own. */
function renderBody(props: { authorType: 'player' | 'agent' | 'bot' | 'system'; body: string }) {
  return render(
    <Suspense fallback={null}>
      <MessageBody {...props} />
    </Suspense>,
  );
}

describe('MessageBody', () => {
  it('renders a bot body as markdown', async () => {
    const { container } = renderBody({ authorType: 'bot', body: MARKDOWN });

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.textContent).not.toContain('**');
  });

  it('renders an agent body as markdown, so pasted article steps read like the bot answer', async () => {
    const { container } = renderBody({ authorType: 'agent', body: MARKDOWN });

    await waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('48 hours'));
  });

  /**
   * The security property, not a formatting preference: ArticleBody is safe only
   * because it omits rehype-raw, and that was reasoned about for agent-authored
   * article bodies — not for an adversarial input source.
   */
  it('renders a player body as literal text, asterisks and all', async () => {
    const { container } = renderBody({ authorType: 'player', body: 'my **game** crashed' });

    await waitFor(() => expect(screen.getByText('my **game** crashed')).toBeInTheDocument());
    expect(container.querySelector('strong')).toBeNull();
  });

  it('renders a system body as literal text', async () => {
    renderBody({ authorType: 'system', body: 'Did this **solve** it?' });

    await waitFor(() => expect(screen.getByText('Did this **solve** it?')).toBeInTheDocument());
  });

  it('does not render raw HTML in a bot body as markup', async () => {
    const { container } = renderBody({ authorType: 'bot', body: '<img src=x onerror="alert(1)">' });

    await waitFor(() => expect(container.textContent).toContain('<img'));
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an image for a message with an attachment', () => {
    render(
      <MessageBody
        authorType="agent"
        body="screenshot.png"
        attachment={{
          id: 'a1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          byteSize: 3,
          url: 'https://example.test/x',
        }}
      />,
    );
    expect(screen.getByAltText('screenshot.png')).toHaveAttribute('src', 'https://example.test/x');
  });

  it('renders both the typed text and the image when a message has real text and an attachment', () => {
    render(
      <MessageBody
        authorType="agent"
        body="here's the fix, see the red arrow"
        attachment={{
          id: 'a1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          byteSize: 3,
          url: 'https://example.test/x',
        }}
      />,
    );
    expect(screen.getByText("here's the fix, see the red arrow")).toBeInTheDocument();
    expect(screen.getByAltText('screenshot.png')).toHaveAttribute('src', 'https://example.test/x');
  });

  it('renders a fallback label when the attachment has no url', () => {
    render(
      <MessageBody
        authorType="agent"
        body="screenshot.png"
        attachment={{
          id: 'a1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          byteSize: 3,
          url: null,
        }}
      />,
    );
    expect(screen.getByText(/Attachment unavailable/)).toBeInTheDocument();
  });

  it('renders a video element (not an img) for a message with a video attachment', () => {
    const { container } = render(
      <MessageBody
        authorType="agent"
        body="clip.mp4"
        attachment={{
          id: 'a1',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 3,
          url: 'https://example.test/clip.mp4',
        }}
      />,
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('src', 'https://example.test/clip.mp4');
    expect(video).toHaveAttribute('controls');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders the fallback label when a video attachment has no url', () => {
    render(
      <MessageBody
        authorType="agent"
        body="clip.mp4"
        attachment={{
          id: 'a1',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 3,
          url: null,
        }}
      />,
    );
    expect(screen.getByText(/Attachment unavailable/)).toBeInTheDocument();
  });
});
