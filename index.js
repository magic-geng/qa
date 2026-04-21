import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { createId } from "./utils/id.js";
import { runMigrations } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "questions.db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

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
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_questions_updatedAt ON questions(updatedAt);
  CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
`);

runMigrations(db);

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
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** 列表（分页 + 筛选 + 按问题模糊搜 + 按 updatedAt 排序） */
app.get("/api/questions", (req, res) => {
  const category = String(req.query.category ?? "ALL");
  const q = String(req.query.q ?? "").trim();
  const order = String(req.query.order ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));

  let where = "WHERE 1=1";
  const params = [];
  if (category && category !== "ALL") {
    where += " AND category = ?";
    params.push(category);
  }
  if (q) {
    where += " AND question LIKE ?";
    params.push(`%${q}%`);
  }

  const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM questions ${where}`);
  const total = countStmt.get(...params).c;

  const listStmt = db.prepare(
    `SELECT * FROM questions ${where} ORDER BY updatedAt ${order} LIMIT ? OFFSET ?`
  );
  const rows = listStmt.all(...params, limit, offset).map(rowToRecord);

  res.json({ items: rows, total });
});

/** 导出全部（备份用） */
app.get("/api/questions/export", (_req, res) => {
  const rows = db.prepare("SELECT * FROM questions ORDER BY updatedAt DESC").all().map(rowToRecord);
  res.json(rows);
});

app.get("/api/questions/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM questions WHERE id = ?").get(req.params.id);
  if (!row) {
    res.status(404).json({ message: "未找到" });
    return;
  }
  res.json(rowToRecord(row));
});

app.post("/api/questions", (req, res) => {
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
     VALUES (@id, @category, @question, @answer, @principle, @prosCons, @application, @createdAt, @updatedAt)`
  ).run(record);
  res.status(201).json(record);
});

app.put("/api/questions/:id", (req, res) => {
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
    `UPDATE questions SET category=@category, question=@question, answer=@answer,
     principle=@principle, prosCons=@prosCons, application=@application, updatedAt=@updatedAt
     WHERE id=@id`
  ).run(record);
  res.json(record);
});

app.delete("/api/questions/:id", (req, res) => {
  const info = db.prepare("DELETE FROM questions WHERE id = ?").run(req.params.id);
  if (info.changes === 0) {
    res.status(404).json({ message: "未找到" });
    return;
  }
  res.status(204).end();
});

/** 批量导入 / 覆盖（按 id upsert） */
app.post("/api/questions/import", (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: "items 必须为非空数组" });
    return;
  }
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO questions (id, category, question, answer, principle, prosCons, application, createdAt, updatedAt)
     VALUES (@id, @category, @question, @answer, @principle, @prosCons, @application, @createdAt, @updatedAt)`
  );
  const update = db.prepare(
    `UPDATE questions SET category=@category, question=@question, answer=@answer,
     principle=@principle, prosCons=@prosCons, application=@application,
     createdAt=@createdAt, updatedAt=@updatedAt WHERE id=@id`
  );
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const raw of rows) {
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
      const exists = db.prepare("SELECT 1 FROM questions WHERE id = ?").get(id);
      if (exists) {
        update.run(row);
      } else {
        insert.run(row);
      }
      n += 1;
    }
    return n;
  });
  const count = tx(items);
  res.json({ count });
});

app.listen(PORT, () => {
  console.log(`QA server listening on http://127.0.0.1:${PORT}`);
  console.log(`SQLite: ${DB_PATH}`);
});
