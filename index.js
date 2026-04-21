import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { createId } from "./utils/id.js";
import { runMigrations } from "./migrate.js";
import { openSqlite } from "./sqlite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "questions.db");

const rowToRecord = (row) => ({
  id: row.id,
  category: row.category,
  question: row.question,
  answer: row.answer,
  principle: row.principle ?? "",
  prosCons: row.prosCons ?? "",
  application: row.application ?? "",
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  viewCount: row.viewCount ?? 0,
});

async function main() {
  const db = await openSqlite(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      principle TEXT NOT NULL DEFAULT '',
      prosCons TEXT NOT NULL DEFAULT '',
      application TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      viewCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_questions_updatedAt ON questions(updatedAt);
    CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
  `);

  runMigrations(db);
  db.persist();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/questions", (req, res) => {
    try {
      const category = String(req.query.category ?? "ALL");
      const q = String(req.query.q ?? "").trim();
      const order = String(req.query.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
      const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));

      let where = "WHERE 1=1";
      const filterParams = [];
      if (category && category !== "ALL") {
        where += " AND category = ?";
        filterParams.push(category);
      }
      if (q) {
        where += " AND question LIKE ?";
        filterParams.push(`%${q}%`);
      }

      const countSql = `SELECT COUNT(*) AS c FROM questions ${where}`;
      const total = db.prepare(countSql).get(...filterParams).c;

      const listSql = `SELECT * FROM questions ${where} ORDER BY updatedAt ${order} LIMIT ? OFFSET ?`;
      const rows = db
        .prepare(listSql)
        .all(...filterParams, limit, offset)
        .map(rowToRecord);

      res.json({ items: rows, total });
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.get("/api/questions/export", (_req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM questions ORDER BY updatedAt DESC").all().map(rowToRecord);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  /** 随机推荐（须放在 /:id 之前，避免 id 被解析成 "random"） */
  app.get("/api/questions/random", (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "40"), 10) || 40));
      const rows = db
        .prepare("SELECT * FROM questions ORDER BY (COALESCE(viewCount, 0) + 1) * ABS(RANDOM() % 10000) DESC LIMIT ?")
        .all(limit)
        .map(rowToRecord);
      res.json({ items: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.get("/api/questions/:id", (req, res) => {
    try {
      const id = req.params.id;
      const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(id);
      if (!row) {
        res.status(404).json({ message: "未找到" });
        return;
      }
      
      // 增加浏览次数
      db.prepare("UPDATE questions SET viewCount = COALESCE(viewCount, 0) + 1 WHERE id = ?").run(id);
      db.persist();

      res.json(rowToRecord({ ...row, viewCount: (row.viewCount ?? 0) + 1 }));
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.post("/api/questions", (req, res) => {
    try {
      const body = req.body ?? {};
      const question = String(body.question ?? "").trim();
      const answer = String(body.answer ?? "").trim();
      if (!question || !answer) {
        res.status(400).json({ message: "question 与 answer 为必填" });
        return;
      }
      const now = Date.now();
      const record = {
        id: createId(),
        category: String(body.category ?? "IOS"),
        question,
        answer,
        principle: String(body.principle ?? "").trim(),
        prosCons: String(body.prosCons ?? "").trim(),
        application: String(body.application ?? "").trim(),
        createdAt: now,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO questions (id, category, question, answer, principle, prosCons, application, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.category,
        record.question,
        record.answer,
        record.principle,
        record.prosCons,
        record.application,
        record.createdAt,
        record.updatedAt
      );
      db.persist();
      res.status(201).json(record);
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.put("/api/questions/:id", (req, res) => {
    try {
      const existing = db.prepare("SELECT * FROM questions WHERE id = ?").get(req.params.id);
      if (!existing) {
        res.status(404).json({ message: "未找到" });
        return;
      }
      const body = req.body ?? {};
      const now = Date.now();
      const record = {
        id: req.params.id,
        category: String(body.category ?? existing.category),
        question: String(body.question ?? existing.question).trim(),
        answer: String(body.answer ?? existing.answer).trim(),
        principle: String(body.principle ?? existing.principle ?? "").trim(),
        prosCons: String(body.prosCons ?? existing.prosCons ?? "").trim(),
        application: String(body.application ?? existing.application ?? "").trim(),
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      if (!record.question || !record.answer) {
        res.status(400).json({ message: "question 与 answer 为必填" });
        return;
      }
      db.prepare(
        `UPDATE questions SET category=?, question=?, answer=?, principle=?, prosCons=?, application=?, updatedAt=?
         WHERE id=?`
      ).run(
        record.category,
        record.question,
        record.answer,
        record.principle,
        record.prosCons,
        record.application,
        record.updatedAt,
        record.id
      );
      db.persist();
      res.json(record);
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.delete("/api/questions/:id", (req, res) => {
    try {
      const info = db.prepare("DELETE FROM questions WHERE id = ?").run(req.params.id);
      if (info.changes === 0) {
        res.status(404).json({ message: "未找到" });
        return;
      }
      db.persist();
      res.status(204).end();
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.post("/api/questions/import", (req, res) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ message: "items 必须为非空数组" });
        return;
      }
      const now = Date.now();
      const count = db.transaction(() => {
        let n = 0;
        for (const raw of items) {
          const question = String(raw.question ?? "").trim();
          const answer = String(raw.answer ?? "").trim();
          if (!question || !answer) continue;
          const id = raw.id && String(raw.id).trim() ? String(raw.id).trim() : createId();
          const createdAt = Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now;
          const updatedAt = Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now;
          const row = {
            id,
            category: String(raw.category ?? "IOS"),
            question,
            answer,
            principle: String(raw.principle ?? "").trim(),
            prosCons: String(raw.prosCons ?? "").trim(),
            application: String(raw.application ?? "").trim(),
            createdAt,
            updatedAt,
          };
          const exists = db.prepare("SELECT 1 AS x FROM questions WHERE id = ?").get(id);
          if (exists) {
            db.prepare(
              `UPDATE questions SET category=?, question=?, answer=?, principle=?, prosCons=?, application=?, createdAt=?, updatedAt=? WHERE id=?`
            ).run(
              row.category,
              row.question,
              row.answer,
              row.principle,
              row.prosCons,
              row.application,
              row.createdAt,
              row.updatedAt,
              row.id
            );
          } else {
            db.prepare(
              `INSERT INTO questions (id, category, question, answer, principle, prosCons, application, createdAt, updatedAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              row.id,
              row.category,
              row.question,
              row.answer,
              row.principle,
              row.prosCons,
              row.application,
              row.createdAt,
              row.updatedAt
            );
          }
          n += 1;
        }
        return n;
      });
      db.persist();
      res.json({ count });
    } catch (e) {
      res.status(500).json({ message: e.message || "服务器错误" });
    }
  });

  app.listen(PORT, () => {
    console.log(`QA server listening on http://127.0.0.1:${PORT}`);
    console.log(`SQLite (sql.js): ${DB_PATH}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
