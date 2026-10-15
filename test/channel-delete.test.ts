import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTS, Mirror } from "../src/mirror.ts";

const saved = HOSTS[0]!.herdr;
afterEach(() => (HOSTS[0]!.herdr = saved));

/** Fake herdr: `pane list` prints the given panes; `tab close` records the id. */
function fakeHerdr(panes: object[]): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "herdr-"));
  const bin = join(dir, "herdr");
  writeFileSync(join(dir, "panes.json"), JSON.stringify({ result: { panes } }));
  writeFileSync(bin, `#!/bin/sh\nif [ "$1 $2" = "pane list" ]; then cat ${dir}/panes.json; elif [ "$1 $2" = "tab close" ]; then echo "$3" > ${dir}/closed; else exit 1; fi\n`);
  chmodSync(bin, 0o755);
  HOSTS[0]!.herdr = bin;
  return { dir };
}

function mirror(): Mirror {
  const m = new Mirror(null, join(mkdtempSync(join(tmpdir(), "map-")), "agents.json"));
  m.entries = [{ machine: "rig", paneId: "w:p1", tabId: "w:t1", workspace: "w", tab: "Demo", name: "demo", channelId: "C1", archived: false }];
  return m;
}

test("idle tab is closed and the mapping dropped", async () => {
  const { dir } = fakeHerdr([{ pane_id: "w:p1", tab_id: "w:t1", agent_status: "idle" }]);
  const m = mirror();
  expect(await m.closeDeleted("C1")).toEqual({ tab: "Demo", result: "closed" });
  expect(readFileSync(join(dir, "closed"), "utf8").trim()).toBe("w:t1");
  expect(m.entries.length).toBe(0);
});

test("working or waiting tab stays open", async () => {
  for (const status of ["working", "blocked"]) {
    fakeHerdr([{ pane_id: "w:p1", tab_id: "w:t1", agent_status: status }]);
    const m = mirror();
    expect((await m.closeDeleted("C1"))?.result).toBe("busy");
    expect(m.entries.length).toBe(1);
  }
});

test("unknown pane state or unmapped channel does nothing", async () => {
  fakeHerdr([]);
  expect((await mirror().closeDeleted("C1"))?.result).toBe("unknown");
  expect(await mirror().closeDeleted("other")).toBeNull();
});
