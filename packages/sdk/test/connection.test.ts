import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type MainToWorkletMessage, type WorkletToMainMessage } from "@audiospan/runtime";
import { RuntimeConnection } from "../src/connection.js";
import { AudiospanError } from "../src/errors.js";
import { Emitter } from "../src/events.js";
import type { WorkletTransport } from "../src/transport.js";

function fakeTransport() {
  let listener: ((m: WorkletToMainMessage) => void) | null = null;
  const sent: MainToWorkletMessage[] = [];
  const transport: WorkletTransport = {
    postMessage: (m) => sent.push(m),
    onMessage: (l) => {
      listener = l;
    },
    close: () => {
      listener = null;
    },
  };
  return { transport, sent, reply: (m: WorkletToMainMessage) => listener?.(m) };
}

describe("RuntimeConnection", () => {
  it("resolves requests by id, rejects on ERROR, and times out", async () => {
    const { transport, sent, reply } = fakeTransport();
    const errors: AudiospanError[] = [];
    const conn = new RuntimeConnection(transport, 30, { onError: (e) => errors.push(e), onDiagnostic: () => {} });
    const p1 = conn.request({ type: "PING", requestId: 1 }, ["ACK"]);
    const p2 = conn.request({ type: "PING", requestId: 2 }, ["ACK"]);
    const p3 = conn.request({ type: "PING", requestId: 3 }, ["ACK"]);
    expect(sent).toHaveLength(3);
    reply({ type: "ACK", requestId: 2 });
    reply({ type: "ERROR", requestId: 1, code: "INSTANCE_NOT_FOUND", message: "nope", instanceId: "x" });
    await expect(p2).resolves.toMatchObject({ type: "ACK" });
    await expect(p1).rejects.toMatchObject({ code: "RUNTIME_ERROR", runtimeCode: "INSTANCE_NOT_FOUND", instanceId: "x" });
    await expect(p3).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    reply({ type: "ERROR", code: "INSTANCE_ERRORED", message: "boom", instanceId: "y" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("INSTANCE_ERRORED");
    reply({ type: "ACK", requestId: 999 }); // stale, ignored
    conn.close();
    await expect(conn.request({ type: "PING", requestId: 4 }, ["ACK"])).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("rejects unexpected response types and pending requests on close", async () => {
    const { transport, reply } = fakeTransport();
    const conn = new RuntimeConnection(transport, 0, { onError: () => {}, onDiagnostic: () => {} });
    const p = conn.request({ type: "PING", requestId: 1 }, ["ACK"]);
    reply({ type: "READY", protocolVersion: PROTOCOL_VERSION, requestId: 1 });
    await expect(p).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
    const pending = conn.request({ type: "PING", requestId: 2 }, ["ACK"]);
    conn.close();
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("cancels a pending request locally and tags DataCloneError posts as clone failures", async () => {
    const { transport, reply } = fakeTransport();
    const conn = new RuntimeConnection(transport, 0, { onError: () => {}, onDiagnostic: () => {} });
    const p = conn.request({ type: "PING", requestId: 1 }, ["ACK"]);
    conn.cancel(1, new AudiospanError("RUNTIME_ERROR", "gone", { runtimeCode: "PROTOCOL_CLONE_FAILED" }));
    await expect(p).rejects.toMatchObject({ runtimeCode: "PROTOCOL_CLONE_FAILED" });
    reply({ type: "ACK", requestId: 1 }); // late reply for a cancelled request is ignored
    conn.cancel(42, new AudiospanError("RUNTIME_ERROR", "unknown")); // no-op for unknown ids

    const throwing: WorkletTransport = {
      postMessage: () => {
        throw new DOMException("could not be cloned", "DataCloneError");
      },
      onMessage: () => {},
      close: () => {},
    };
    const c2 = new RuntimeConnection(throwing, 0, { onError: () => {}, onDiagnostic: () => {} });
    await expect(c2.request({ type: "PING", requestId: 1 }, ["ACK"])).rejects.toMatchObject({ code: "RUNTIME_ERROR", runtimeCode: "PROTOCOL_CLONE_FAILED" });
  });
});

describe("Emitter", () => {
  it("isolates listener errors and supports once/unsubscribe", () => {
    const caught: unknown[] = [];
    const e = new Emitter<{ a: number }>((err) => caught.push(err));
    const seen: number[] = [];
    e.once("a", (v) => seen.push(v));
    e.on("a", () => {
      throw new Error("bad listener");
    });
    const off = e.on("a", (v) => seen.push(v * 10));
    e.emit("a", 1);
    off();
    e.emit("a", 2);
    expect(seen).toEqual([1, 10]);
    expect(caught).toHaveLength(2);
    expect(e.listenerCount()).toBe(1);
    e.clear();
    expect(e.listenerCount()).toBe(0);
  });
});
