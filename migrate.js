/**
 * 轻量迁移：每次部署拉代码后，Node 启动时会按顺序执行未跑过的迁移。
 * - 每条迁移有唯一 id，执行成功会写入 schema_migrations，不会重复执行。
 * - 加字段前用 columnExists 判断，老库也能安全升级。
 * - 不要改已经发布过的迁移 id / 内容；要改结构就新增一条迁移。
 */

export function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

export function tableExists(db, table) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  return Boolean(row);
}

/** @type {{ id: string, up: (db: any) => void }[]} */
const migrations = [
  {
    id: "20260421_add_viewCount",
    up(db) {
      if (!columnExists(db, "questions", "viewCount")) {
        db.exec("ALTER TABLE questions ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0;");
      }
    },
  },
];

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((r) => r.id));

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    m.up(db);
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, Date.now());
  }
}
