import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function bindAndRun(db, sql, params) {
  db.run(sql, params);
  return { changes: db.getRowsModified() };
}

function prepare(db, sql) {
  return {
    get(...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const stmt = db.prepare(sql);
      stmt.bind(flat);
      if (!stmt.step()) {
        stmt.free();
        return undefined;
      }
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    all(...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      const stmt = db.prepare(sql);
      stmt.bind(flat);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    },
    run(...params) {
      const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      return bindAndRun(db, sql, flat);
    },
  };
}

/**
 * 纯 JS SQLite（sql.js），无需编译 native 模块，适合 Node 18.x 与老系统。
 * 与 better-sqlite3 生成的 .db 文件格式兼容，可直接打开已有库。
 */
export async function openSqlite(dbPath) {
  const wasmDir = path.join(__dirname, "node_modules", "sql.js", "dist");
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });

  let db;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new SQL.Database();
  }

  const persist = () => {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  };

  const api = {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return prepare(db, sql);
    },
    transaction(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
    persist,
  };

  return api;
}
