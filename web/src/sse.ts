import type { RoomEvent } from "./types";

/**
 * Incremental parser for a Server-Sent Events stream. Feed it text chunks as they arrive; it returns the complete events
 * found so far and keeps any partial frame for the next chunk. Comment lines (": keep-alive") and `retry:` are ignored.
 */
export function createSseParser() {
  let buf = "";
  return (chunk: string): RoomEvent[] => {
    buf += chunk.replace(/\r\n/g, "\n");
    const out: RoomEvent[] = [];
    for (let end = buf.indexOf("\n\n"); end !== -1; end = buf.indexOf("\n\n")) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let id: string | undefined;
      let type = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") type = value;
        else if (field === "data") data.push(value);
      }
      if (data.length === 0) continue;
      try {
        const body = JSON.parse(data.join("\n")) as { at: string; data: unknown };
        out.push({ seq: id !== undefined && id !== "" ? Number(id) : undefined, at: body.at, type, data: body.data });
      } catch {
        /* a malformed frame is skipped, never fatal */
      }
    }
    return out;
  };
}
