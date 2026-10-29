import { describe, expect, it, vi } from "vitest";
import { ScreenWakeLock, type WakeLockDocument, type WakeLockNavigator } from "./wakeLock";

function fakeSentinel() {
  const listeners: (() => void)[] = [];
  return {
    release: vi.fn(async () => undefined),
    addEventListener: (_t: "release", l: () => void) => listeners.push(l),
    fireRelease: () => listeners.forEach((l) => l()), // the browser released it (page hidden)
  };
}

function fakeDoc(state = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: state,
    addEventListener: (_t: "visibilitychange", l: () => void) => listeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void) => listeners.delete(l),
    show() {
      doc.visibilityState = "visible";
      listeners.forEach((l) => l());
    },
    hide() {
      doc.visibilityState = "hidden";
      listeners.forEach((l) => l());
    },
    count: () => listeners.size,
  };
  return doc as typeof doc & WakeLockDocument;
}

describe("screen wake lock", () => {
  it("requests a screen lock and holds it", async () => {
    const s = fakeSentinel();
    const request = vi.fn(async () => s);
    const lock = new ScreenWakeLock({ wakeLock: { request } } as WakeLockNavigator, fakeDoc());
    expect(lock.supported).toBe(true);
    expect(await lock.acquire()).toBe(true);
    expect(request).toHaveBeenCalledWith("screen");
    expect(lock.held).toBe(true);
    await lock.acquire(); // asking again does not ask the browser again
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is a no-op where the browser has no wake lock", async () => {
    const lock = new ScreenWakeLock({} as WakeLockNavigator, fakeDoc());
    expect(lock.supported).toBe(false);
    expect(await lock.acquire()).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(new ScreenWakeLock(undefined, undefined).supported).toBe(false);
    expect(await new ScreenWakeLock(undefined, undefined).acquire()).toBe(false);
  });

  it("carries on quietly when the browser refuses the lock", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    const lock = new ScreenWakeLock({ wakeLock: { request } } as WakeLockNavigator, fakeDoc());
    expect(await lock.acquire()).toBe(false);
    expect(lock.held).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("asks again when the page is shown again after the browser released the lock", async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const doc = fakeDoc();
    const lock = new ScreenWakeLock({ wakeLock: { request } } as WakeLockNavigator, doc);
    await lock.acquire();
    doc.hide();
    first.fireRelease(); // the browser drops the lock when the page is hidden
    expect(lock.held).toBe(false);
    expect(request).toHaveBeenCalledTimes(1); // nothing is asked of a hidden page
    doc.show();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(lock.held).toBe(true));
  });

  it("does not ask again after release(), and releases the held lock", async () => {
    const s = fakeSentinel();
    const request = vi.fn(async () => s);
    const doc = fakeDoc();
    const lock = new ScreenWakeLock({ wakeLock: { request } } as WakeLockNavigator, doc);
    await lock.acquire();
    expect(doc.count()).toBe(1);
    await lock.release();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
    expect(doc.count()).toBe(0); // the listener is gone
    doc.hide();
    doc.show();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    await lock.release(); // releasing twice is fine
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("a lock that arrives after release() is let go at once", async () => {
    let resolve!: (s: ReturnType<typeof fakeSentinel>) => void;
    const s = fakeSentinel();
    const request = vi.fn(() => new Promise<ReturnType<typeof fakeSentinel>>((r) => (resolve = r)));
    const lock = new ScreenWakeLock({ wakeLock: { request } } as unknown as WakeLockNavigator, fakeDoc());
    const pending = lock.acquire();
    await lock.release();
    resolve(s);
    expect(await pending).toBe(false);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });

  it("survives a lock the browser already released when release() is called", async () => {
    const s = fakeSentinel();
    s.release.mockRejectedValueOnce(new Error("already released"));
    const lock = new ScreenWakeLock({ wakeLock: { request: async () => s } } as WakeLockNavigator, fakeDoc());
    await lock.acquire();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
