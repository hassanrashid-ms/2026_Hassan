import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useSurfaceReadySignal } from './useSurfaceReadySignal.ts';

function Probe({ resolved }: { resolved: boolean }) {
  useSurfaceReadySignal(resolved);
  return null;
}

/** Stands in for the bridge the SDK injects, recording what the page posts. */
function installBridge(): unknown[] {
  const posted: unknown[] = [];
  (window as { SupportBridge?: unknown }).SupportBridge = {
    post: (message: unknown) => posted.push(message),
  };
  return posted;
}

describe('useSurfaceReadySignal', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge;
  });

  it('posts surface_ready once the surface has something to show', async () => {
    const posted = installBridge();

    render(<Probe resolved />);

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]));
  });

  it('stays silent while the surface is still an empty frame', async () => {
    const posted = installBridge();

    render(<Probe resolved={false} />);

    // Long enough for both animation frames to have run had they been scheduled.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
  });

  it('posts exactly once when the surface resolves, then re-renders', async () => {
    const posted = installBridge();

    const { rerender } = render(<Probe resolved />);
    await waitFor(() => expect(posted).toHaveLength(1));

    rerender(<Probe resolved />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(posted).toEqual([{ type: 'surface_ready' }]);
  });

  it('waits for a bridge that has not been injected yet', async () => {
    // The SDK injects the bridge in its page-load callback, which can land after
    // React has already mounted and painted. Posting into the void here would
    // hide the surface until the SDK's grace timer gave up.
    render(<Probe resolved />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const posted = installBridge();
    window.dispatchEvent(new Event('supportbridgeready'));

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]));
  });

  it('also wakes on a supportbridgeready dispatched at document', async () => {
    render(<Probe resolved />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const posted = installBridge();
    document.dispatchEvent(new Event('supportbridgeready'));

    await waitFor(() => expect(posted).toEqual([{ type: 'surface_ready' }]));
  });

  it('does not post twice when the SDK dispatches at both targets', async () => {
    render(<Probe resolved />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const posted = installBridge();
    window.dispatchEvent(new Event('supportbridgeready'));
    document.dispatchEvent(new Event('supportbridgeready'));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted).toEqual([{ type: 'surface_ready' }]);
  });

  /*
   * With a bridge already present the signal is sent synchronously on mount, and
   * that is deliberate: it used to wait two animation frames, which never arrive
   * while the SDK holds the native view hidden — the signal waited on a paint that
   * the signal itself had to unblock. So the guarantee is no longer "unmount
   * cancels a pending post"; it is that a surface which goes away before the
   * bridge shows up never speaks for a page that is no longer there.
   */
  it('does not post when the bridge arrives after the surface unmounts', async () => {
    const { unmount } = render(<Probe resolved />);
    unmount();

    const posted = installBridge();
    window.dispatchEvent(new Event('supportbridgeready'));
    document.dispatchEvent(new Event('supportbridgeready'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toEqual([]);
  });

  it('posts immediately when the bridge is already there, without waiting for a frame', () => {
    const posted = installBridge();
    // No rAF stub and no awaiting: a hidden webview never delivers a frame, so
    // anything that needed one here would deadlock on the real device.
    render(<Probe resolved />);

    expect(posted).toEqual([{ type: 'surface_ready' }]);
  });
});
