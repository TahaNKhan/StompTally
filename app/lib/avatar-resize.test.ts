import { describe, expect, it } from "vitest";
import { centerSquare } from "./avatar-resize";

describe("centerSquare", () => {
  it("crops a landscape photo to its middle", () => {
    expect(centerSquare(4000, 3000)).toEqual({ sx: 500, sy: 0, side: 3000 });
  });
  it("crops a portrait photo to its middle", () => {
    expect(centerSquare(3000, 4000)).toEqual({ sx: 0, sy: 500, side: 3000 });
  });
  it("keeps a square photo whole", () => {
    expect(centerSquare(800, 800)).toEqual({ sx: 0, sy: 0, side: 800 });
  });
  it("never reaches outside the image, including odd sizes", () => {
    for (const [w, h] of [[1001, 777], [777, 1001], [1, 5], [5, 1]]) {
      const { sx, sy, side } = centerSquare(w, h);
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sx + side).toBeLessThanOrEqual(w);
      expect(sy + side).toBeLessThanOrEqual(h);
    }
  });
});
