import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// Layout APIs the overlay primitives call and a DOM without layout does not have.
class Observer { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= Observer as unknown as typeof ResizeObserver;
const element = Element.prototype as unknown as Record<string, unknown>;
element.scrollIntoView ??= () => {};
element.hasPointerCapture ??= () => false;
element.setPointerCapture ??= () => {};
element.releasePointerCapture ??= () => {};
