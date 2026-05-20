/**
 * DOM test infrastructure (T14). The repo's component tests historically used
 * react-test-renderer, which has no DOM — `@dnd-kit` drag and @testing-library
 * queries need a real `document`. Importing this module FIRST in a test file
 * installs a jsdom window/document onto the Node globals.
 */
import { JSDOM } from 'jsdom';

let installed = false;

export function installJsdom(): void {
  if (installed) {
    return;
  }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://aries.example.test/dashboard/calendar',
    pretendToBeVisual: true,
  });

  const win = dom.window as unknown as Window & typeof globalThis;

  // Copy the jsdom window onto Node globals so React + @testing-library and
  // @dnd-kit see a browser-like environment. Some globals (notably `navigator`
  // in Node 22) are getter-only, so assign via defineProperty.
  const globalAny = globalThis as unknown as Record<string, unknown>;
  const assignGlobal = (key: string, value: unknown) => {
    try {
      globalAny[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
  };

  assignGlobal('window', win);
  assignGlobal('document', win.document);
  assignGlobal('navigator', win.navigator);
  assignGlobal('HTMLElement', win.HTMLElement);
  assignGlobal('Element', win.Element);
  assignGlobal('Node', win.Node);
  assignGlobal('Event', win.Event);
  assignGlobal('KeyboardEvent', win.KeyboardEvent);
  assignGlobal('MouseEvent', win.MouseEvent);
  assignGlobal('getComputedStyle', win.getComputedStyle.bind(win));
  assignGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    win.setTimeout(() => cb(Date.now()), 0) as unknown as number,
  );
  assignGlobal('cancelAnimationFrame', (handle: number) => win.clearTimeout(handle));

  // matchMedia is referenced by some UI libs; jsdom does not implement it.
  if (!win.matchMedia) {
    win.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof win.matchMedia;
  }

  installed = true;
}
