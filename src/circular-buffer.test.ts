import { describe, it, expect } from "vitest";
import { CircularBuffer } from "./cdp-client.js";

describe("CircularBuffer", () => {
  it("pushes and peeks items", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.peek()).toEqual([1, 2]);
    expect(buf.length).toBe(2);
  });

  it("drain returns items and clears buffer", () => {
    const buf = new CircularBuffer<string>(5);
    buf.push("a");
    buf.push("b");
    expect(buf.drain()).toEqual(["a", "b"]);
    expect(buf.length).toBe(0);
    expect(buf.peek()).toEqual([]);
  });

  it("evicts oldest items when full", () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.peek()).toEqual([2, 3, 4]);
    expect(buf.length).toBe(3);
  });

  it("peek does not modify buffer", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.peek();
    buf.peek();
    expect(buf.length).toBe(1);
  });

  it("works with size of 1", () => {
    const buf = new CircularBuffer<string>(1);
    buf.push("a");
    buf.push("b");
    expect(buf.peek()).toEqual(["b"]);
  });
});
