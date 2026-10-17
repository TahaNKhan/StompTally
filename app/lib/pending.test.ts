import { describe, expect, it } from "vitest";
import { getPendingMessage, pendingLabel } from "./pending";

const idle = { state: "idle" };
const formData = (intent: string) => ({ get: () => intent });

describe("pending feedback", () => {
  it("idle has no overlay", () => expect(getPendingMessage(idle, [])).toBeNull());
  it("Continue immediately shows login feedback", () => {
    expect(getPendingMessage({ state: "submitting", formMethod: "POST", formAction: "/auth/private-token?next=/" }, [])).toBe("Logging you in…");
  });
  it("redirect loader remains visibly pending after login", () => {
    expect(getPendingMessage({ state: "loading" }, [])).toBe("Loading your page…");
  });
  it("GET page navigation shows loading", () => expect(getPendingMessage({ state: "loading", formMethod: "GET" }, [])).toBe("Loading your page…"));
  it("background fetcher reads are silent", () => {
    expect(getPendingMessage(idle, [{ state: "loading" }, { state: "loading", formMethod: "GET" }])).toBeNull();
  });
  for (const state of ["submitting", "loading"]) {
    it(`step save shows feedback during ${state}`, () => {
      expect(getPendingMessage(idle, [{ state, formMethod: "post", formData: formData("manual") }])).toBe("Saving your steps…");
    });
  }
  it("completed mutations do not leave a stuck overlay", () => {
    expect(getPendingMessage(idle, [{ state: "idle", formMethod: "POST", formData: formData("manual") }])).toBeNull();
  });
  it("navigation takes priority over a concurrent mutation", () => {
    expect(getPendingMessage({ state: "loading" }, [{ state: "submitting", formMethod: "POST" }])).toBe("Loading your page…");
  });
  it("skip claims and undo get distinct messages", () => {
    expect(pendingLabel({ state: "submitting", formData: formData("skip") })).toBe("Claiming your skip…");
    expect(pendingLabel({ state: "submitting", formData: formData("unskip") })).toBe("Undoing your skip…");
  });
  it("mail and logout get distinct messages", () => {
    expect(pendingLabel({ state: "submitting", formAction: "/login" })).toBe("Sending your email…");
    expect(pendingLabel({ state: "submitting", formAction: "/logout" })).toBe("Logging out…");
  });
});
