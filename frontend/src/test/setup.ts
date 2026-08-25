import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library's waitFor() only knows how to poll under fake timers if it
// can see a `jest`-shaped global (it checks `typeof jest` directly). Vitest
// exposes `vi`, not `jest`, so without this shim any test that combines
// `vi.useFakeTimers()` with `waitFor()` deadlocks: the promise chain resolves
// via microtasks, but waitFor's re-check is scheduled on the (fake, frozen)
// interval and never fires.
(globalThis as { jest?: unknown }).jest ??= {
  advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms),
};

afterEach(() => {
  cleanup();
});

/*
 * jsdom implements neither of these, and Radix's dismissable layers plus
 * react-virtuoso's viewport measurement both call them on mount. Without the
 * stubs every component test that opens a Sheet or Dialog throws.
 */
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Virtuoso's scrollToIndex calls scrollTo on its scroller, which jsdom leaves
// undefined — anything that scrolls the thread to a new message throws without this.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
