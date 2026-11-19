import type { RoomService } from "./service.js";
import type { RoomEvent } from "./types.js";

/**
 * Starts delivering an interview's room events: first everything stored after `afterSeq` (a reconnecting browser sends the
 * last id it saw), then live ones. Returns the function that stops it.
 *
 * Subscribing BEFORE the replay and buffering meanwhile means nothing is lost between "read the past" and "listen to the
 * future"; events seen in both places are dropped by seq. Transient events (live partial transcript) carry no seq and are
 * delivered as they come.
 */
export async function openLive(room: RoomService, interviewId: string, afterSeq: number, send: (e: RoomEvent) => void): Promise<() => void> {
  let replaying = true;
  let last = afterSeq;
  const buffered: RoomEvent[] = [];
  const deliver = (e: RoomEvent) => {
    if (e.seq !== undefined) {
      if (e.seq <= last) return;
      last = e.seq;
    }
    send(e);
  };
  const unsubscribe = room.bus.subscribe(interviewId, (e) => (replaying ? buffered.push(e) : deliver(e)));
  try {
    for (;;) {
      const page = await room.rooms.eventsAfter(interviewId, last, 500);
      if (page.length === 0) break;
      for (const e of page) deliver(e);
    }
    replaying = false;
    for (const e of buffered.splice(0)) deliver(e);
  } catch (e) {
    unsubscribe();
    throw e;
  }
  return unsubscribe;
}

export const sseFrame = (e: RoomEvent): string => `${e.seq !== undefined ? `id: ${e.seq}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify({ at: e.at, data: e.data })}\n\n`;
