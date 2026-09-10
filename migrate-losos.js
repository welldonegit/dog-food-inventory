// ─────────────────────────────────────────────────────────────────────────────
// ВРЕМЕННАЯ МИГРАЦИЯ: исправление цены в поставке 11.05.2026 15:29
//
// В поставке id=1778502566259 у позиции «Лосось для великих» (id=6, 1 кг)
// закупочная ціна была 0 — должно быть 150.08 ₴/кг.
//
// Скрипт «переигрывает» цепочку средньої собівартості этой позиции ровно по
// формулам приложения, начиная с этой поставки и до текущего состояния:
//   • пересчитывает newCOGS / newAvg в самой поставке 11.05;
//   • re-blend средньої на каждой последующей ПОСТАВКЕ id=6 (22.05, 07.07);
//   • обновляет avgCost id=6 в снимках stockBefore/stockAfter всех последующих
//     записей журнала;
//   • пересчитывает cogsTotal во всех последующих ПРОДАЖАХ id=6;
//   • обновляет итоговую avg_cost в stock_items.
//
// Количества (qty) НЕ трогаются — отдельный баг 160/60 вне этой правки.
//
// Запуск локально (dry-run):   node migrate-losos.js path/to/feedstock.db
// Запуск локально (запись):     node migrate-losos.js path/to/feedstock.db --apply
// Экспортируется также как модуль для временного endpoint (dry/apply).
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_DELIVERY_ID = 1778502566259; // поставка 11.05.2026 15:29
const ITEM_ID   = 6;
const ITEM_NAME = 'Лосось для великих';
const ITEM_PS   = 1;
const NEW_PRICE = 150.08;

const round4 = x => Math.round(x * 10000) / 10000;                 // как в приложении
const isTargetLine = x => x.name === ITEM_NAME && x.ps === ITEM_PS; // строка позиции в items[]
const findId6 = arr => (arr || []).find(x => x.id === ITEM_ID);    // элемент снимка по id

// Чистая функция: принимает массив {id, e(parsed)} по возрастанию id,
// мутирует объекты e и возвращает журнал изменений.
function computePlan(entries) {
  const changes = [];          // человекочитаемый список правок
  let currentAvg = null;       // округлённая средняя id=6 (то, что «живёт» в складе)
  let started = false;

  const push = (entryId, date, type, field, before, after) =>
    changes.push({ entryId, date, type, field, before, after });

  for (const { id, e } of entries) {
    if (id < TARGET_DELIVERY_ID) continue;

    if (id === TARGET_DELIVERY_ID) {
      // ── сама поставка 11.05: правим цену и пересчитываем ────────────────────
      const line   = e.items.find(isTargetLine);
      const before = findId6(e.stockBefore);
      if (!line || !before) throw new Error('11.05: не найдена строка/снимок id=6');

      const qtyB = before.qty, avgB = before.avgCost;
      push(id, e.date, e.type, 'items.price',   line.price,   NEW_PRICE);
      line.price = NEW_PRICE;

      const newCOGS = NEW_PRICE + line.ohPerUnit / ITEM_PS + line.logPerKg;
      push(id, e.date, e.type, 'items.newCOGS', line.newCOGS, newCOGS);
      line.newCOGS = newCOGS;

      const newAvgU = (qtyB * avgB + line.qty * newCOGS) / (qtyB + line.qty);
      push(id, e.date, e.type, 'items.newAvg',  line.newAvg,  newAvgU);
      line.newAvg = newAvgU;                       // в журнале хранится НЕокруглённым
      currentAvg  = round4(newAvgU);               // в складе/снимках — округлённое

      const after = findId6(e.stockAfter);
      if (after) { push(id, e.date, e.type, 'stockAfter.avgCost', after.avgCost, currentAvg); after.avgCost = currentAvg; }

      started = true;
      continue;
    }

    if (!started) continue;

    // ── все последующие записи ────────────────────────────────────────────────
    const sb = findId6(e.stockBefore);
    if (sb && sb.avgCost !== currentAvg) { push(id, e.date, e.type, 'stockBefore.avgCost', sb.avgCost, currentAvg); sb.avgCost = currentAvg; }

    if (e.type === 'delivery') {
      const line = e.items.find(isTargetLine);
      if (line) {
        // цена здесь корректна — newCOGS не трогаем, пересчитываем только newAvg
        const qtyB    = sb ? sb.qty : findId6(e.stockBefore).qty;
        const newAvgU = (qtyB * currentAvg + line.qty * line.newCOGS) / (qtyB + line.qty);
        push(id, e.date, e.type, 'items.newAvg', line.newAvg, newAvgU);
        line.newAvg = newAvgU;
        currentAvg  = round4(newAvgU);
        const after = findId6(e.stockAfter);
        if (after) { push(id, e.date, e.type, 'stockAfter.avgCost', after.avgCost, currentAvg); after.avgCost = currentAvg; }
      } else {
        const after = findId6(e.stockAfter); // на случай, если снимок «после» содержит id=6 без строки
        if (after && after.avgCost !== currentAvg) { push(id, e.date, e.type, 'stockAfter.avgCost', after.avgCost, currentAvg); after.avgCost = currentAvg; }
      }
    } else if (e.type === 'sale') {
      const line = e.items.find(isTargetLine);
      if (line) {
        push(id, e.date, e.type, 'items.avgCost',   line.avgCost,   currentAvg);
        line.avgCost = currentAvg;
        const cogs = line.qty * currentAvg * ITEM_PS;
        push(id, e.date, e.type, 'items.cogsTotal', line.cogsTotal, cogs);
        line.cogsTotal = cogs;
      }
      const after = findId6(e.stockAfter);
      if (after && after.avgCost !== currentAvg) { push(id, e.date, e.type, 'stockAfter.avgCost', after.avgCost, currentAvg); after.avgCost = currentAvg; }
    }
  }

  return { changes, finalAvg: currentAvg };
}

// ── Прогон против better-sqlite3 (для endpoint и локального CLI) ───────────────
function run(db, { apply = false } = {}) {
  const rows    = db.prepare('SELECT id, entry_json FROM journal_entries ORDER BY id').all();
  const entries = rows.map(r => ({ id: r.id, e: JSON.parse(r.entry_json) }));

  // защита от повторного применения
  const target = entries.find(x => x.id === TARGET_DELIVERY_ID);
  if (!target) throw new Error('Поставка 11.05 (id=' + TARGET_DELIVERY_ID + ') не найдена');
  const targetLine = target.e.items.find(isTargetLine);
  const alreadyFixed = targetLine && targetLine.price === NEW_PRICE;

  const stockRow = db.prepare('SELECT avg_cost FROM stock_items WHERE id=?').get(ITEM_ID);
  const stockBeforeAvg = stockRow ? stockRow.avg_cost : null;

  const { changes, finalAvg } = computePlan(entries);

  const result = {
    alreadyFixed,
    itemId: ITEM_ID,
    stockAvg: { before: stockBeforeAvg, after: finalAvg },
    journalChanges: changes,
    changedEntries: [...new Set(changes.map(c => c.entryId))].length,
    applied: false,
  };

  if (apply && !alreadyFixed) {
    const tx = db.transaction(() => {
      const upd = db.prepare('UPDATE journal_entries SET entry_json=? WHERE id=?');
      for (const { id, e } of entries) {
        if (id < TARGET_DELIVERY_ID) continue;
        upd.run(JSON.stringify(e), id);
      }
      db.prepare('UPDATE stock_items SET avg_cost=? WHERE id=?').run(finalAvg, ITEM_ID);
    });
    tx();
    result.applied = true;
  }

  return result;
}

module.exports = { run, computePlan, TARGET_DELIVERY_ID, ITEM_ID, NEW_PRICE };

// CLI
if (require.main === module) {
  const dbPath = process.argv[2];
  const apply  = process.argv.includes('--apply');
  if (!dbPath) { console.error('Usage: node migrate-losos.js <db> [--apply]'); process.exit(1); }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const res = run(db, { apply });
  console.log(JSON.stringify(res, null, 2));
  console.log(`\n${apply ? (res.applied ? 'ЗАСТОСОВАНО' : 'вже виправлено, пропущено') : 'DRY-RUN (нічого не записано)'}`);
  console.log(`stock_items id=${res.itemId} avg_cost: ${res.stockAvg.before} → ${res.stockAvg.after}`);
  console.log(`змінено записів журналу: ${res.changedEntries}`);
}
