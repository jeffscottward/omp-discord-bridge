import { describe, expect, test } from "bun:test";
import { noteIsLate, showWorking } from "../src/working";

describe("showWorking", () => {
  test("edits the queued note in place", async () => {
    const calls: string[] = [];
    const note = { edit: async () => (calls.push("edit"), "note"), delete: async () => calls.push("delete") };
    const m = await showWorking(note, {}, async () => (calls.push("post"), "posted"));
    expect(m).toBe("note");
    expect(calls).toEqual(["edit"]);
  });

  test("no note: posts at the bottom", async () => {
    const m = await showWorking(undefined, {}, async () => "posted");
    expect(m).toBe("posted");
  });

  test("edit fails: deletes the note, then posts", async () => {
    const calls: string[] = [];
    const note = {
      edit: async () => {
        calls.push("edit");
        throw new Error("Unknown Message");
      },
      delete: async () => calls.push("delete"),
    };
    const m = await showWorking(note, {}, async () => (calls.push("post"), "posted"));
    expect(m).toBe("posted");
    expect(calls).toEqual(["edit", "delete", "post"]);
  });

  test("edit and delete both fail: still posts", async () => {
    const note = {
      edit: async () => Promise.reject(new Error("x")),
      delete: async () => Promise.reject(new Error("y")),
    };
    expect(await showWorking(note, {}, async () => "posted")).toBe("posted");
  });
});

describe("noteIsLate", () => {
  test("job still queued: note is valid", () => expect(noteIsLate(5, [4, 5, 6])).toBe(false));
  test("job already started or cancelled: note is late", () => expect(noteIsLate(5, [6, 7])).toBe(true));
});
