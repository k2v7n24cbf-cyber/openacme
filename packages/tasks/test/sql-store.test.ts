import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { applySchema, WasmDatabase } from "../../db/src/index.js";
import { createCommentStore } from "../../db/src/stores/comment-store.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore, TaskStoreError } from "../src/store.js";

let dir: string;
let db: WasmDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openacme-sql-tasks-"));
  db = new WasmDatabase(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore SQL-backed reads", () => {
  it("imports markdown tasks once and reads from SQL after files are gone", async () => {
    const fileStore = new TaskStore(dir);
    const imported = await fileStore.create({
      title: "Investigate local flap",
      assignee: "ops",
      created_by: "acme",
      body: "RCA body",
      session_id: "session-1",
      status: "system_blocked",
      team: "platform",
    });

    const sqlStore = new TaskStore(dir, { db });
    const read = sqlStore.get(imported.id);
    expect(read).toMatchObject({
      id: imported.id,
      title: "Investigate local flap",
      status: "system_blocked",
      assignee: "ops",
      session_id: "session-1",
      team: "platform",
    });
    expect(read?.body.trim()).toBe("RCA body");

    unlinkSync(path.join(dir, `${imported.id}.md`));

    expect(sqlStore.get(imported.id)?.title).toBe("Investigate local flap");
    expect(
      sqlStore.list({ status: "system_blocked" }).map((t) => t.id),
    ).toEqual([imported.id]);
    expect(sqlStore.list({ assignee: "ops" }).map((t) => t.id)).toEqual([
      imported.id,
    ]);
    expect(sqlStore.list({ session_id: "session-1" }).map((t) => t.id)).toEqual(
      [imported.id],
    );
    expect(sqlStore.list({ team: "platform" }).map((t) => t.id)).toEqual([
      imported.id,
    ]);
  });

  it("surfaces legacy import constraint conflicts as typed TaskStoreError", async () => {
    const fileStore = new TaskStore(dir);
    const first = await fileStore.create({
      title: "First active",
      assignee: "ops",
      created_by: "acme",
      session_id: "session-1",
      status: "in_progress",
    });
    writeFileSync(
      path.join(dir, "2.md"),
      `---\nid: "2"\ntitle: Second active\nstatus: in_progress\nassignee: ops\nsession_id: session-1\ncreated_by: acme\ncreated_in_session_id: null\nparent_id: null\ndepends_on: []\nstart_at: null\ndue_at: null\ncreated_at: "${first.created_at}"\nupdated_at: "${first.updated_at}"\nclosed_at: null\nrecurrence: null\nruns: 0\nlast_run_at: null\nteam: null\n---\n\n`,
      "utf8",
    );

    expect(() => new TaskStore(dir, { db })).toThrow(
      expect.objectContaining({
        code: "migration_conflict",
      }),
    );
  });
});

describe("TaskStore SQL-backed writes", () => {
  it("creates tasks in SQL without writing new markdown task files", async () => {
    const sqlStore = new TaskStore(dir, { db });

    const task = await sqlStore.create({
      title: "Move task storage",
      assignee: "platform",
      created_by: "acme",
      body: "Use SQLite",
    });

    expect(task.id).toBe("1");
    expect(existsSync(path.join(dir, "1.md"))).toBe(false);
    expect(sqlStore.get("1")).toMatchObject({
      title: "Move task storage",
      assignee: "platform",
    });
    expect(sqlStore.get("1")?.body.trim()).toBe("Use SQLite");
  });

  it("allocates unique SQL ids for parallel creates", async () => {
    const sqlStore = new TaskStore(dir, { db });

    const created = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        sqlStore.create({
          title: `Task ${idx}`,
          assignee: "platform",
          created_by: "acme",
        }),
      ),
    );

    expect(created.map((task) => task.id).sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("lets the DB reject parallel in_progress updates for the same session", async () => {
    const sqlStore = new TaskStore(dir, { db });
    const first = await sqlStore.create({
      title: "First",
      assignee: "platform",
      created_by: "acme",
      session_id: "session-1",
    });
    const second = await sqlStore.create({
      title: "Second",
      assignee: "platform",
      created_by: "acme",
      session_id: "session-1",
    });

    const results = await Promise.allSettled([
      sqlStore.update(first.id, { status: "in_progress" }),
      sqlStore.update(second.id, { status: "in_progress" }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(TaskStoreError);
    expect(rejected?.reason).toMatchObject({ code: "session_busy" });
    expect(sqlStore.list({ status: "in_progress" })).toHaveLength(1);
  });

  it("maps SQL create constraint failures and rolls back id allocation", async () => {
    const sqlStore = new TaskStore(dir, { db });
    await sqlStore.create({
      title: "First active",
      assignee: "platform",
      created_by: "acme",
      session_id: "session-1",
      status: "in_progress",
    });

    await expect(
      sqlStore.create({
        title: "Second active",
        assignee: "platform",
        created_by: "acme",
        session_id: "session-1",
        status: "in_progress",
      }),
    ).rejects.toMatchObject({ code: "session_busy" });

    const next = await sqlStore.create({
      title: "Next open",
      assignee: "platform",
      created_by: "acme",
    });
    expect(next.id).toBe("2");
    expect(sqlStore.list()).toHaveLength(2);
  });

  it("updates system_blocked tasks in SQL and clears start_at", async () => {
    const sqlStore = new TaskStore(dir, { db });
    const task = await sqlStore.create({
      title: "Provider failed",
      assignee: "platform",
      created_by: "acme",
      start_at: "2026-07-30T00:00:00.000Z",
    });

    const updated = await sqlStore.update(task.id, {
      status: "system_blocked",
    });

    expect(updated.status).toBe("system_blocked");
    expect(updated.start_at).toBeNull();
    expect(sqlStore.get(task.id)?.status).toBe("system_blocked");
    expect(sqlStore.get(task.id)?.start_at).toBeNull();
  });

  it("deletes SQL task rows and their comments", async () => {
    const commentStore = createCommentStore(db);
    const sqlStore = new TaskStore(dir, { db, commentStore });
    const task = await sqlStore.create({
      title: "Delete me",
      assignee: "platform",
      created_by: "acme",
    });
    await sqlStore.addComment({
      taskId: task.id,
      author: "acme",
      body: "Attached comment",
    });

    await sqlStore.delete(task.id);

    expect(sqlStore.get(task.id)).toBeNull();
    expect(commentStore.list(task.id)).toEqual([]);
  });
});
