const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'data', 'feedstock.db'));

// ── SCHEMA ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL DEFAULT 'Нова позиція',
    qty        REAL    NOT NULL DEFAULT 0,
    avg_cost   REAL    NOT NULL DEFAULT 0,
    pack_size  REAL    NOT NULL DEFAULT 1,
    category   TEXT    NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    id         INTEGER PRIMARY KEY,
    type       TEXT    NOT NULL,
    entry_json TEXT    NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default data on first run
if (!db.prepare('SELECT 1 FROM stock_items LIMIT 1').get()) {
  const ins = db.prepare(
    'INSERT INTO stock_items (name,qty,avg_cost,pack_size,category,sort_order) VALUES (?,?,?,?,?,?)'
  );
  [
    ['Яловичина для малих',   94, 188.05,  1, 'малі породи',              0],
    ['Індичка для малих',     77, 171.21,  1, 'малі породи',              1],
    ['Лосось для малих',      35, 207.71,  1, 'малі породи',              2],
    ['Яловичина для великих', 66, 151.06,  1, 'великі та середні породи', 3],
    ['Індичка для великих',   71, 150.10,  1, 'великі та середні породи', 4],
    ['Лосось для великих',    37, 188.957, 1, 'великі та середні породи', 5],
  ].forEach(r => ins.run(...r));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ───────────────────────────────────────────────────────────────────
const rowToItem = r => ({
  id: r.id, name: r.name, qty: r.qty,
  avgCost: r.avg_cost, ps: r.pack_size, cat: r.category,
});

// ── STOCK API ─────────────────────────────────────────────────────────────────

// GET all stock items
app.get('/api/stock', (req, res) => {
  res.json(
    db.prepare('SELECT * FROM stock_items ORDER BY sort_order, id').all().map(rowToItem)
  );
});

// POST — add new item
app.post('/api/stock', (req, res) => {
  const { name = 'Нова позиція', qty = 0, avgCost = 0, ps = 1, cat = '' } = req.body;
  const maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM stock_items').get().m;
  const r = db.prepare(
    'INSERT INTO stock_items (name,qty,avg_cost,pack_size,category,sort_order) VALUES (?,?,?,?,?,?)'
  ).run(name, qty, avgCost, ps, cat, maxOrd + 1);
  res.json({ id: r.lastInsertRowid });
});

// PATCH — update one field (or several) of one item
app.patch('/api/stock/:id', (req, res) => {
  const { name, qty, avgCost, ps, cat } = req.body;
  db.prepare(`
    UPDATE stock_items
    SET name      = COALESCE(?, name),
        qty       = COALESCE(?, qty),
        avg_cost  = COALESCE(?, avg_cost),
        pack_size = COALESCE(?, pack_size),
        category  = COALESCE(?, category)
    WHERE id = ?
  `).run(name ?? null, qty ?? null, avgCost ?? null, ps ?? null, cat ?? null, req.params.id);
  res.json({ ok: true });
});

// DELETE — remove one item
app.delete('/api/stock/:id', (req, res) => {
  db.prepare('DELETE FROM stock_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── JOURNAL API ───────────────────────────────────────────────────────────────

// GET all journal entries (newest first)
app.get('/api/journal', (req, res) => {
  const rows = db.prepare(
    'SELECT id, type, entry_json FROM journal_entries ORDER BY id DESC'
  ).all();
  res.json(rows.map(r => ({ ...JSON.parse(r.entry_json), id: r.id, type: r.type })));
});

// POST — apply delivery or sale:
//   saves journal entry AND updates stock atomically in one transaction
app.post('/api/journal', (req, res) => {
  const entry = req.body;
  if (!entry.id || !entry.type || !Array.isArray(entry.stockAfter)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  db.transaction(() => {
    const upd = db.prepare('UPDATE stock_items SET qty=?, avg_cost=? WHERE id=?');
    entry.stockAfter.forEach(item => upd.run(item.qty, item.avgCost, item.id));
    db.prepare('INSERT INTO journal_entries (id, type, entry_json) VALUES (?,?,?)')
      .run(entry.id, entry.type, JSON.stringify(entry));
  })();
  res.json({ ok: true });
});

// DELETE — undo last entry: restores stockBefore and removes the entry atomically
app.delete('/api/journal/:id', (req, res) => {
  const row = db.prepare('SELECT entry_json FROM journal_entries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const entry = JSON.parse(row.entry_json);
  db.transaction(() => {
    const upd = db.prepare('UPDATE stock_items SET qty=?, avg_cost=? WHERE id=?');
    entry.stockBefore.forEach(item => upd.run(item.qty, item.avgCost, item.id));
    db.prepare('DELETE FROM journal_entries WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущено: http://localhost:${PORT}`);
});
