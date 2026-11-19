import type { RoomEvent } from "./types.js";

/** In-process fan-out of room events to the browsers watching an interview. One backend instance (see doc/data.md). */
export class RoomBus {
  private subs = new Map<string, Set<(e: RoomEvent) => void>>();

  subscribe(interviewId: string, fn: (e: RoomEvent) => void): () => void {
    const set = this.subs.get(interviewId) ?? new Set();
    set.add(fn);
    this.subs.set(interviewId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(interviewId);
    };
  }

  publish(interviewId: string, e: RoomEvent) {
    for (const fn of [...(this.subs.get(interviewId) ?? [])]) {
      try {
        fn(e);
      } catch {
        /* a broken client must not stop the others */
      }
    }
  }

  watchers(interviewId: string): number {
    return this.subs.get(interviewId)?.size ?? 0;
  }
}
