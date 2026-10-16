import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      let params = [];
      const statement = {
        bind(...values) { params = values; return statement; },
        async first() {
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...params) };
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      };
      return statement;
    },
    async exec(sql) { db.exec(sql); return { count: 0, duration: 0 }; },
    close() { db.close(); },
  };
}
