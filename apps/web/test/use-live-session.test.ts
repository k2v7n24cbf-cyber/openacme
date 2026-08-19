import { describe, expect, it } from "vitest";
import { mergeLiveMessages } from "../app/lib/useLiveSession";
import type { OpenAcmeUIMessage } from "../app/lib/types";

function assistant(id: string, text: string): OpenAcmeUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as OpenAcmeUIMessage;
}

describe("mergeLiveMessages", () => {
  it("does not let transient snapshots rewind an actively streamed assistant message", () => {
    const prev = [assistant("a1", "hello world")];
    const out = mergeLiveMessages(prev, [assistant("a1", "hello")], {
      activeMessageId: "a1",
      transient: true,
    });

    expect(out).toEqual(prev);
  });

  it("applies transient snapshots when no raw stream is active for that message", () => {
    const out = mergeLiveMessages([], [assistant("a1", "hello")], {
      activeMessageId: null,
      transient: true,
    });

    expect(out).toEqual([assistant("a1", "hello")]);
  });

  it("applies canonical messages even when they match the active stream id", () => {
    const out = mergeLiveMessages(
      [assistant("a1", "hello")],
      [assistant("a1", "hello world")],
      {
        activeMessageId: "a1",
        transient: false,
      }
    );

    expect(out).toEqual([assistant("a1", "hello world")]);
  });
});
