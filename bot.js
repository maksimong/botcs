/**
 * CS2 Bet Bot — Node.js версия (Telegraf + better-sqlite3)
 *
 * Установка:
 *   npm install
 *
 * Запуск:
 *   BOT_TOKEN="токен" ADMIN_IDS="111,222" node bot.js
 *
 * Хранилище: SQLite-файл bets.db в этой же папке (создаётся автоматически).
 */

require("dotenv").config();
const { Telegraf } = require("telegraf");
const Database = require("better-sqlite3");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

if (!BOT_TOKEN) {
  console.error("Задайте переменную окружения BOT_TOKEN");
  process.exit(1);
}

// На обычном сервере/у себя на компьютере база лежит рядом со скриптом.
// На Railway (или другом хостинге с постоянным диском) переменная
// RAILWAY_VOLUME_MOUNT_PATH указывает на смонтированный volume — туда и пишем,
// чтобы файл bets.db не терялся при перезапусках/обновлениях.
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const db = new Database(path.join(DB_DIR, "bets.db"));
db.pragma("journal_mode = WAL");

// ---------- Схема БД ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS lobbies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', -- open / closed
    created_by INTEGER,
    created_at TEXT,
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lobby_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    creator_name TEXT,
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', -- open / matched / cancelled / settled
    opponent_id INTEGER,
    opponent_name TEXT,
    matched_at TEXT,
    winner TEXT, -- 'creator' / 'opponent'
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS lineups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    match_time TEXT,
    team1 TEXT, -- 5 ников через перенос строки
    team2 TEXT, -- 5 ников через перенос строки
    created_by INTEGER,
    created_at TEXT
  );
`);

// ---------- Помощники ----------

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

// Приватный ответ админу: удаляет команду админа из группового чата (если у бота
// есть права на удаление) и отправляет подробный ответ в личку. Если бот не может
// написать в личку (админ ни разу не жал /start боту) — отвечает в группе как раньше,
// с пояснением, что нужно сделать, чтобы ответы приходили приватно.
async function replyPrivately(ctx, text, extra) {
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // бот не админ группы или не может удалить сообщение — не критично, продолжаем
  }

  try {
    await ctx.telegram.sendMessage(ctx.from.id, text, extra);
  } catch (e) {
    await ctx.reply(
      text +
        "\n\n⚠️ Не удалось написать вам в личку — откройте диалог с ботом и нажмите /start, " +
        "тогда ответы на админ-команды будут приходить приватно.",
      extra
    );
  }
}

function getActiveLobby(chatId) {
  return db
    .prepare(
      "SELECT * FROM lobbies WHERE chat_id=? AND status='open' ORDER BY id DESC LIMIT 1"
    )
    .get(chatId);
}

function getActiveLineup(chatId) {
  return db
    .prepare("SELECT * FROM lineups WHERE chat_id=? ORDER BY id DESC LIMIT 1")
    .get(chatId);
}

function fmtBet(b) {
  if (b.status === "open") {
    return `#${b.id} — ${b.creator_name}: ${b.amount.toFixed(2)}$ [ждёт соперника]`;
  }
  if (b.status === "matched") {
    return `#${b.id} — ${b.creator_name} vs ${b.opponent_name}: ${b.amount.toFixed(
      2
    )}$ каждый [матч]`;
  }
  if (b.status === "settled") {
    const winnerName = b.winner === "creator" ? b.creator_name : b.opponent_name;
    return `#${b.id} — ${b.creator_name} vs ${b.opponent_name}: ${b.amount.toFixed(
      2
    )}$, победитель: ${winnerName} ✅`;
  }
  if (b.status === "cancelled") {
    return `#${b.id} — ${b.creator_name}: ${b.amount.toFixed(2)}$ [отменена]`;
  }
  return `#${b.id}`;
}

const LINEUP_TEMPLATE =
  "Использование (каждая строка отдельно, всего 12 строк):\n\n" +
  "/set_lineup\n" +
  "19:00\n" +
  "ник1\nник2\nник3\nник4\nник5\n" +
  "ник6\nник7\nник8\nник9\nник10\n\n" +
  "1-я строка — команда, 2-я — время начала по МСК, " +
  "следующие 5 строк — состав команды 1, последние 5 строк — состав команды 2.";

const HELP_TEXT =
  "🎮 CS2 Bet Bot\n\n" +
  "Для всех:\n" +
  "/bet <сумма> — поставить сумму на себя (можно ставить сколько угодно раз)\n" +
  "/bets — список ставок в текущем лобби\n" +
  "/accept <id> — принять чужую ставку\n" +
  "/mystats — моя статистика\n" +
  "/lineup или /составы — показать составы команд и время начала\n\n" +
  "Для админов:\n" +
  "/create_lobby <название> — открыть приём ставок\n" +
  "/close_lobby — закрыть приём ставок\n" +
  "/result <id> creator|opponent — зафиксировать победителя\n" +
  "/del_bet <id> — удалить ставку\n" +
  "/export — выгрузить CSV с историей\n" +
  "/set_lineup — назначить составы команд и время начала (см. шаблон ниже)\n\n" +
  "ℹ️ Ответы на эти команды и сама команда приходят вам приватно и удаляются из группы " +
  "(нужно один раз нажать /start боту в личке и дать боту права админа группы " +
  "на удаление сообщений).\n\n" +
  LINEUP_TEMPLATE;

// ---------- Бот ----------

const bot = new Telegraf(BOT_TOKEN);

bot.command(["help", "start"], (ctx) => ctx.reply(HELP_TEXT));

// --- Админ: лобби ---

bot.command("create_lobby", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может создавать лобби.");

  const title = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!title) return replyPrivately(ctx, "Использование: /create_lobby Navi vs Vitality");

  const existing = getActiveLobby(ctx.chat.id);
  if (existing) {
    return replyPrivately(
      ctx,
      `Уже есть открытое лобби #${existing.id} (${existing.title}). Сначала закройте его: /close_lobby`
    );
  }

  const info = db
    .prepare(
      "INSERT INTO lobbies (chat_id, title, status, created_by, created_at) VALUES (?,?,?,?,?)"
    )
    .run(ctx.chat.id, title, "open", ctx.from.id, nowIso());

  await replyPrivately(
    ctx,
    `✅ Лобби #${info.lastInsertRowid} открыто: ${title}\nПишите /bet <сумма>, например: /bet 100`
  );

  // Публичное объявление для всех — без деталей, просто что приём ставок открыт
  await ctx.telegram.sendMessage(
    ctx.chat.id,
    `🎮 Приём ставок открыт: ${title}\nСтавьте командой /bet <сумма>`
  );
});

bot.command("close_lobby", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может закрывать лобби.");

  const lobby = getActiveLobby(ctx.chat.id);
  if (!lobby) return replyPrivately(ctx, "Нет открытого лобби.");

  db.prepare("UPDATE lobbies SET status='closed', closed_at=? WHERE id=?").run(
    nowIso(),
    lobby.id
  );

  await replyPrivately(
    ctx,
    `🔒 Лобби #${lobby.id} (${lobby.title}) закрыто.\n` +
      `Не забудьте зафиксировать результаты: /result <bet_id> creator|opponent`
  );

  await ctx.telegram.sendMessage(ctx.chat.id, `🔒 Приём ставок закрыт: ${lobby.title}`);
});

bot.command("del_bet", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может удалять ставки.");

  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    return replyPrivately(ctx, "Использование: /del_bet <id>");
  }

  const betId = Number(args[1]);
  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);
  if (!bet) return replyPrivately(ctx, "Ставка не найдена.");

  db.prepare("UPDATE bets SET status='cancelled' WHERE id=?").run(betId);
  await replyPrivately(ctx, `🗑 Ставка #${betId} удалена (отменена).`);
});

bot.command("result", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может фиксировать результат.");

  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 3 || !/^\d+$/.test(args[1]) || !["creator", "opponent"].includes(args[2])) {
    return replyPrivately(
      ctx,
      "Использование: /result <bet_id> creator|opponent\n" +
        "(creator — выиграл тот, кто создал ставку; opponent — тот, кто её принял)"
    );
  }

  const betId = Number(args[1]);
  const winner = args[2];

  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);
  if (!bet) return replyPrivately(ctx, "Ставка не найдена.");
  if (bet.status !== "matched") {
    return replyPrivately(ctx, "Результат можно зафиксировать только для сматченной ставки.");
  }

  db.prepare("UPDATE bets SET status='settled', winner=? WHERE id=?").run(winner, betId);

  const winnerName = winner === "creator" ? bet.creator_name : bet.opponent_name;
  await replyPrivately(ctx, `✅ Ставка #${betId} завершена. Победитель: ${winnerName}`);
});

bot.command("export", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может выгружать историю.");

  const rows = db
    .prepare(
      `SELECT b.*, l.title as lobby_title FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? ORDER BY b.id`
    )
    .all(ctx.chat.id);

  const header = "bet_id,lobby,creator,opponent,amount,status,winner,created_at,matched_at\n";
  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows
    .map((r) =>
      [
        r.id,
        r.lobby_title,
        r.creator_name,
        r.opponent_name,
        r.amount,
        r.status,
        r.winner,
        r.created_at,
        r.matched_at,
      ]
        .map(csvEscape)
        .join(",")
    )
    .join("\n");

  const csv = "\uFEFF" + header + body; // BOM для корректной кириллицы в Excel

  try {
    await ctx.deleteMessage();
  } catch (e) {
    // не критично, если не получилось
  }

  try {
    await ctx.telegram.sendDocument(ctx.from.id, {
      source: Buffer.from(csv, "utf-8"),
      filename: "bets_history.csv",
    });
  } catch (e) {
    await ctx.replyWithDocument(
      { source: Buffer.from(csv, "utf-8"), filename: "bets_history.csv" },
      { caption: "⚠️ Не смог отправить в личку — откройте диалог с ботом и нажмите /start." }
    );
  }
});

// --- Админ: составы ---

bot.command("set_lineup", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может назначать составы.");

  const lines = ctx.message.text.split("\n");
  if (lines.length < 12) return replyPrivately(ctx, LINEUP_TEMPLATE);

  const matchTime = lines[1].trim();
  const team1 = lines.slice(2, 7).map((l) => l.trim());
  const team2 = lines.slice(7, 12).map((l) => l.trim());

  if (!matchTime || team1.some((n) => !n) || team2.some((n) => !n)) {
    return replyPrivately(ctx, "Время и все 10 ников должны быть заполнены.\n\n" + LINEUP_TEMPLATE);
  }

  db.prepare(
    `INSERT INTO lineups (chat_id, match_time, team1, team2, created_by, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(ctx.chat.id, matchTime, team1.join("\n"), team2.join("\n"), ctx.from.id, nowIso());

  await replyPrivately(ctx, "✅ Составы обновлены. Посмотреть: /lineup или /составы");
});

// Показ составов: /lineup работает как обычная команда, а /составы (кириллица)
// Telegram не распознаёт как bot_command, поэтому ловим её через hears по тексту.
function showLineup(ctx) {
  const lineup = getActiveLineup(ctx.chat.id);
  if (!lineup) return ctx.reply("Составы ещё не назначены.");

  const team1 = lineup.team1.split("\n");
  const team2 = lineup.team2.split("\n");
  const width = Math.max(...team1.map((n) => n.length), ...team2.map((n) => n.length), "Команда 1".length) + 3;

  const pad = (s) => s + " ".repeat(width - s.length);
  const rows = team1.map((a, i) => pad(a) + team2[i]).join("\n");
  const text =
    `⏰ Начало: ${lineup.match_time} МСК\n\n` +
    `<pre>${pad("Команда 1")}Команда 2\n${rows}</pre>`;

  ctx.reply(text, { parse_mode: "HTML" });
}

bot.command("lineup", showLineup);
bot.hears(/^\/составы(?:@\w+)?\b/i, showLineup);

// --- Пользователи: ставки ---

bot.command("bet", (ctx) => {
  const lobby = getActiveLobby(ctx.chat.id);
  if (!lobby) {
    return ctx.reply("Сейчас нет открытого лобби для ставок. Ждите /create_lobby от админа.");
  }

  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 2) return ctx.reply("Использование: /bet 100");

  const amount = parseFloat(parts[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    return ctx.reply("Сумма должна быть положительным числом. Пример: /bet 100");
  }

  const info = db
    .prepare(
      `INSERT INTO bets (lobby_id, creator_id, creator_name, amount, status, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(lobby.id, ctx.from.id, ctx.from.first_name || ctx.from.username || "Игрок", amount, "open", nowIso());

  const betId = info.lastInsertRowid;
  ctx.reply(
    `💰 Ставка #${betId} создана: ${ctx.from.first_name} ставит ${amount.toFixed(2)}$ на себя.\n` +
      `Кто-то может принять её командой /accept ${betId} (тоже ставя ${amount.toFixed(2)}$ на себя).`
  );
});

bot.command("accept", (ctx) => {
  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    return ctx.reply("Использование: /accept <bet_id>");
  }

  const betId = Number(args[1]);
  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);

  if (!bet) return ctx.reply("Ставка не найдена.");
  if (bet.status !== "open") return ctx.reply("Эта ставка уже недоступна для принятия.");
  if (bet.creator_id === ctx.from.id) return ctx.reply("Нельзя принять собственную ставку.");

  db.prepare(
    `UPDATE bets SET status='matched', opponent_id=?, opponent_name=?, matched_at=? WHERE id=?`
  ).run(ctx.from.id, ctx.from.first_name || ctx.from.username || "Игрок", nowIso(), betId);

  ctx.reply(
    `🤝 Ставка #${betId} принята! ${bet.creator_name} vs ${ctx.from.first_name}, ${bet.amount.toFixed(
      2
    )}$ на кону.`
  );
});

bot.command("bets", (ctx) => {
  const lobby = getActiveLobby(ctx.chat.id);
  let rows, header;

  if (lobby) {
    rows = db.prepare("SELECT * FROM bets WHERE lobby_id=? ORDER BY id").all(lobby.id);
    header = `📋 Лобби #${lobby.id} (${lobby.title})\n\n`;
  } else {
    const last = db
      .prepare("SELECT * FROM lobbies WHERE chat_id=? ORDER BY id DESC LIMIT 1")
      .get(ctx.chat.id);
    if (!last) return ctx.reply("Пока нет ни одного лобби.");
    rows = db.prepare("SELECT * FROM bets WHERE lobby_id=? ORDER BY id").all(last.id);
    header = `📋 Лобби #${last.id} (${last.title}) — закрыто\n\n`;
  }

  if (rows.length === 0) return ctx.reply(header + "Ставок пока нет.");

  const openBets = rows.filter((r) => r.status === "open");
  const matchedBets = rows.filter((r) => r.status === "matched");
  const settledBets = rows.filter((r) => r.status === "settled");

  let text = header;
  if (openBets.length) text += "🟢 Открытые ставки:\n" + openBets.map(fmtBet).join("\n") + "\n\n";
  if (matchedBets.length) text += "🔵 Активные матчи:\n" + matchedBets.map(fmtBet).join("\n") + "\n\n";
  if (settledBets.length) text += "✅ Завершённые:\n" + settledBets.map(fmtBet).join("\n");

  ctx.reply(text.trim());
});

bot.command("mystats", (ctx) => {
  const userId = ctx.from.id;
  const rows = db
    .prepare(
      `SELECT * FROM bets WHERE status='settled' AND (creator_id=? OR opponent_id=?)`
    )
    .all(userId, userId);

  let wins = 0;
  let losses = 0;
  let net = 0;

  for (const r of rows) {
    const won =
      (r.winner === "creator" && r.creator_id === userId) ||
      (r.winner === "opponent" && r.opponent_id === userId);
    if (won) {
      wins += 1;
      net += r.amount;
    } else {
      losses += 1;
      net -= r.amount;
    }
  }

  ctx.reply(
    `📊 Статистика ${ctx.from.first_name}\n` +
      `Побед: ${wins}\nПоражений: ${losses}\nБаланс: ${net >= 0 ? "+" : ""}${net.toFixed(2)}$`
  );
});

bot.launch().then(() => console.log("Бот запущен"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
