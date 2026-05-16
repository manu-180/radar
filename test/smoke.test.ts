import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("la suite de tests arranca en verde", () => {
    expect(1 + 1).toBe(2);
  });
});
