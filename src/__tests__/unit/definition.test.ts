import { describe, expect, it } from "vitest"

import { droppedField } from "../../tools/definition.ts"

describe("droppedField", () => {
  it("finds nothing when the serialised value keeps every field", () => {
    const value = { a: 1, b: [{ c: "x" }], d: undefined }
    expect(droppedField(value, { a: 1, b: [{ c: "x" }] }, "payload")).toBeUndefined()
  })

  it("names a nested field that was dropped", () => {
    expect(droppedField({ a: { b: 1 } }, { a: {} }, "")).toBe("a.b")
  })

  it("names an array that was not serialised as one", () => {
    expect(droppedField({ a: [1] }, { a: "1" }, "payload")).toBe("payload.a")
  })

  it("names an object that was not serialised as one", () => {
    expect(droppedField([{ a: 1 }], [null], "payload")).toBe("payload.0")
  })

  it("ignores scalar values", () => {
    expect(droppedField(1, 2, "payload")).toBeUndefined()
  })
})
