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
const { Telegraf, Markup } = require("telegraf");
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

  -- Telegram Bot API не даёт получить список всех участников группы напрямую
  -- (ограничение приватности) — поэтому запоминаем каждого, кто хоть раз
  -- написал боту любую команду. Используется для /all.
  CREATE TABLE IF NOT EXISTS known_users (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT,
    PRIMARY KEY (chat_id, user_id)
  );

  -- Список юзернеймов, которые админ задал вручную для тега всех (/all).
  -- Работает надёжнее, чем known_users, но требует, чтобы у людей был @username.
  CREATE TABLE IF NOT EXISTS tag_lists (
    chat_id INTEGER PRIMARY KEY,
    usernames TEXT, -- юзернеймы через перенос строки, без символа @
    updated_at TEXT
  );

  -- Комиссия админу: 5% с выигрыша, начисляется автоматически при фиксации
  -- результата ставки. paid=0 — долг ещё не оплачен, paid=1 — закрыт.
  CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    bet_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    amount REAL NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    paid_at TEXT
  );
`);

// Миграция: добавляем колонку для id закреплённого сообщения с кнопками ставок.
// В try/catch — чтобы не падать, если колонка уже была добавлена раньше.
try {
  db.exec("ALTER TABLE lobbies ADD COLUMN pinned_message_id INTEGER");
} catch (e) {
  // колонка уже существует — это нормально
}

// Миграция: username нужен, чтобы админ мог добавлять/редактировать ставки за
// игроков по @юзернейму, а не только по числовому id.
try {
  db.exec("ALTER TABLE known_users ADD COLUMN username TEXT");
} catch (e) {
  // колонка уже существует — это нормально
}

// ---------- Общая логика ставок (используется и командами, и кнопками) ----------

const QUICK_AMOUNTS = [50, 100, 200, 500];

// Комиссия админу с каждого выигрыша. Легко поменять на другой процент — например,
// на 0.1 для 10%.
const COMMISSION_RATE = 0.05;

// Inline-кнопки (не занимают поле ввода и не видны тем, кто их не трогает —
// в отличие от reply-клавиатуры, которая одна на весь чат для всех участников).
function quickBetKeyboard() {
  return Markup.inlineKeyboard(
    QUICK_AMOUNTS.map((a) => Markup.button.callback(`${a}$`, `quickbet:${a}`))
  );
}

function acceptKeyboard(betId) {
  return Markup.inlineKeyboard([
    Markup.button.callback("🤝 Принять ставку", `accept:${betId}`),
  ]);
}

// Создаёт ставку в БД. Возвращает {ok:true, betId, amount} или {ok:false, error}.
function createBet(chatId, userId, userName, amount) {
  const lobby = getActiveLobby(chatId);
  if (!lobby) return { ok: false, error: "Сейчас нет открытого лобби для ставок." };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Сумма должна быть положительным числом." };
  }

  const info = db
    .prepare(
      `INSERT INTO bets (lobby_id, creator_id, creator_name, amount, status, created_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(lobby.id, userId, userName, amount, "open", nowIso());

  return { ok: true, betId: info.lastInsertRowid, amount };
}

// Принимает ставку. Возвращает {ok:true, bet, text} или {ok:false, error}.
function acceptBet(betId, userId, userName) {
  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);
  if (!bet) return { ok: false, error: "Ставка не найдена." };
  if (bet.status !== "open") return { ok: false, error: "Эта ставка уже недоступна для принятия." };
  if (bet.creator_id === userId) return { ok: false, error: "Нельзя принять собственную ставку." };

  db.prepare(
    `UPDATE bets SET status='matched', opponent_id=?, opponent_name=?, matched_at=? WHERE id=?`
  ).run(userId, userName, nowIso(), betId);

  const text = `🤝 Ставка #${betId} принята! ${bet.creator_name} vs ${userName}, ${bet.amount.toFixed(
    2
  )}$ на кону.`;

  return { ok: true, bet, text };
}

function userDisplayName(from) {
  return from.first_name || from.username || "Игрок";
}

// Находит игрока по @username или числовому telegram id — используется в
// админских командах /add_bet и /edit_bet, где нужно указать конкретного человека
// без того, чтобы он сам писал команду в момент создания ставки.
function resolveUser(chatId, identifier) {
  if (/^\d+$/.test(identifier)) {
    const id = Number(identifier);
    const row = db.prepare("SELECT name FROM known_users WHERE chat_id=? AND user_id=?").get(chatId, id);
    return { id, name: row ? row.name : `Игрок ${id}` };
  }

  const username = identifier.replace(/^@/, "").toLowerCase();
  const row = db
    .prepare("SELECT user_id, name FROM known_users WHERE chat_id=? AND LOWER(username)=?")
    .get(chatId, username);

  return row ? { id: row.user_id, name: row.name } : null;
}

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
    )}$ каждый `;
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
  "/bet <сумма> или /ставка <сумма> — поставить сумму на себя (можно ставить сколько угодно раз)\n" +
  "/bets или /ставки — список ставок в текущем лобби\n" +
  "/accept <id> — принять чужую ставку\n" +
  "/cancel <id> — отменить свою ставку (сам создатель или принявший, пока нет результата)\n" +
  "/mystats — моя статистика\n" +
  "/top — общий рейтинг всех участников чата\n" +
  "/debts или /долги — кто сколько должен админу по комиссии\n" +
  "/badges или /бейджи — список всех бейджей и как их получить\n" +
  "/регламент или /правила — правила денежных матчей\n" +
  "/lineup или /составы — показать составы команд и время начала\n" +
  "/комса — кошелёк админа для расчётов\n\n" +
  "💡 Пока лобби открыто, кнопки быстрой ставки 50$/100$/200$/500$ есть в закреплённом " +
  "сообщении наверху чата, а принять чужую ставку можно кнопкой под сообщением о ней.\n\n" +
  "Для админов:\n" +
  "/create_lobby — открыть приём ставок\n" +
  "/close_lobby — закрыть приём ставок\n" +
  "/result <id> creator|opponent — зафиксировать победителя\n" +
  "/del_bet <id> — удалить ставку\n" +
  "/add_bet <игрок1> <игрок2> <сумма> — добавить ставку вручную (@username или id)\n" +
  "/edit_bet <id> amount|creator|opponent <значение> — отредактировать ставку\n" +
  "/export — выгрузить CSV с историей\n" +
  "/set_lineup — назначить составы команд и время начала (см. шаблон ниже)\n" +
  "/set_all_usernames — задать список юзернеймов для /all вручную (см. пример ниже)\n" +
  "/all или /все [текст] — тегнуть всех из списка (или тех, кто писал боту, если список не задан)\n" +
  "/paid <user_id> — отметить, что участник рассчитался по комиссии (id смотреть в /debts)\n\n" +
  "Пример /set_all_usernames:\n" +
  "/set_all_usernames vasya, petya123, kolya_cs\n\n" +
  "ℹ️ Ответы на эти команды и сама команда приходят вам приватно и удаляются из группы " +
  "(нужно один раз нажать /start боту в личке и дать боту права админа группы " +
  "на удаление сообщений).\n\n" +
  LINEUP_TEMPLATE;

// ---------- Бот ----------

const bot = new Telegraf(BOT_TOKEN);

// Запоминаем каждого, кто написал боту что-либо в группе — единственный способ
// со временем узнать реальных участников чата (см. пояснение у таблицы known_users).
bot.use((ctx, next) => {
  try {
    if (ctx.from && ctx.chat && ctx.chat.type !== "private" && !ctx.from.is_bot) {
      db.prepare(
        `INSERT INTO known_users (chat_id, user_id, name, username) VALUES (?,?,?,?)
         ON CONFLICT(chat_id, user_id) DO UPDATE SET name=excluded.name, username=excluded.username`
      ).run(ctx.chat.id, ctx.from.id, userDisplayName(ctx.from), ctx.from.username || null);
    }
  } catch (e) {
    // не критично, если не получилось — просто пропускаем
  }
  return next();
});

bot.command(["help", "start"], (ctx) => ctx.reply(HELP_TEXT));

const REGLAMENT_TEXT =
  "📜 <b>Регламент денежных матчей CS2 (5x5)</b>\n\n" +
  "<b>💰 1. Выплата ставок</b>\n" +
  "Проигравшая сторона обязана выплатить ставку в течение 24 часов после окончания матча.\n" +
  "По взаимной договорённости обеих сторон срок выплаты может быть изменён.\n" +
  "При просрочке выплаты без предварительной договорённости начисляется пеня 5% от суммы долга за каждые последующие 24 часа.\n" +
  "В случае систематических задержек или отказа от выплаты администрация оставляет за собой право ограничить участие игрока в денежных матчах или исключить его из чата.\n\n" +
  "<b>🔧 2. Технические проблемы</b>\n" +
  "При вылете игрока команда имеет 20 минут на его возвращение в матч.\n" +
  "Если за 20 минут игрок не вернулся:\n" +
  "— по взаимному согласию команд матч может быть перенесён на дату не позднее 3 рабочих дней с сохранением текущего счёта;\n" +
  "— если согласия нет, команда доигрывает текущую карту 4х5. На следующую карту разрешается взять замену сопоставимого уровня игры, которая должна быть одобрена командой соперника.\n" +
  "Если игрок вылетел после начала раунда и команда не успела взять паузу, раунд доигрывается 4х5. Переигровка раунда не производится, так как на данный момент отсутствует техническая возможность сделать бэкап.\n\n" +
  "<b>🚫 3. Неспортивное поведение</b>\n" +
  "Намеренный слив матча, игра против своей команды, передача информации сопернику или любые другие действия, направленные на умышленное поражение команды, запрещены.\n" +
  "Если факт намеренного слива подтверждён администрацией, виновный игрок обязан полностью компенсировать ставки всех игроков своей команды, а также может быть временно или навсегда исключён из чата.\n\n" +
  "<b>🚨 4. Читы и запрещённое ПО</b>\n" +
  "Любое использование читов, макросов, запрещённого программного обеспечения, а также доказанный стримснайп запрещены.\n" +
  "За нарушение — техническое поражение, аннулирование результата матча и исключение из чата.\n\n" +
  "<b>⚖️ 5. Спорные ситуации</b>\n" +
  "Все спорные ситуации стороны должны попытаться урегулировать между собой.\n" +
  "Если правило не описывает конкретную ситуацию или команды не смогли прийти к соглашению, окончательное решение принимает администрация чата.\n" +
  "Решение администрации является окончательным и обязательно для всех участников.\n\n" +
  "<b>⏰ 6. Опоздание и отмена участия</b>\n" +
  "За опоздание на матч более чем на 20 минут без предварительной договорённости игрок получает штраф $100.\n" +
  "Если игрок сообщил о невозможности участия менее чем за 30 минут до начала матча и не смог самостоятельно найти себе замену, он также получает штраф $100.\n\n" +
  "<b>📌 7. Заключительные положения</b>\n" +
  "Администрация оставляет за собой право изменять и дополнять настоящий регламент.\n" +
  "Все изменения публикуются в чате и вступают в силу с момента публикации.";

bot.hears(/^\/регламент(?:@\w+)?(?=\s|$)/i, (ctx) =>
  ctx.reply(REGLAMENT_TEXT, { parse_mode: "HTML" })
);
bot.hears(/^\/правила(?:@\w+)?(?=\s|$)/i, (ctx) =>
  ctx.reply(REGLAMENT_TEXT, { parse_mode: "HTML" })
);

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeUsername(u) {
  return u.trim().replace(/^@/, "");
}

// Админ задаёт список юзернеймов вручную — надёжнее, чем ждать, пока люди
// сами напишут боту. Каждый юзернейм на отдельной строке, с @ или без — неважно.
bot.command("set_all_usernames", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может настраивать список для тега.");

  const lines = ctx.message.text
    .split("\n")
    .slice(1) // первая строка — сама команда /set_all_usernames
    .map((l) => normalizeUsername(l))
    .filter(Boolean);

  // Если список не многострочный, а через запятую в той же строке — тоже поддержим
  const inlineArgs = ctx.message.text.split("\n")[0].split(/\s+/).slice(1).join(" ");
  const inlineUsernames = inlineArgs
    .split(",")
    .map((u) => normalizeUsername(u))
    .filter(Boolean);

  const usernames = [...new Set([...lines, ...inlineUsernames])];

  if (usernames.length === 0) {
    return replyPrivately(
      ctx,
      "Использование — юзернеймы через запятую или каждый на новой строке, без @ или с ним:\n\n" +
        "/set_all_usernames vasya, petya123, kolya_cs\n\n" +
        "или:\n\n" +
        "/set_all_usernames\nvasya\npetya123\nkolya_cs"
    );
  }

  db.prepare(
    `INSERT INTO tag_lists (chat_id, usernames, updated_at) VALUES (?,?,?)
     ON CONFLICT(chat_id) DO UPDATE SET usernames=excluded.usernames, updated_at=excluded.updated_at`
  ).run(ctx.chat.id, usernames.join("\n"), nowIso());

  await replyPrivately(ctx, `✅ Список для /all сохранён: ${usernames.length} юзернейм(ов).`);
});

// Тегает всех. Приоритет — список юзернеймов, заданный вручную через
// /set_all_usernames (надёжнее). Если он не задан — используются те, кто
// уже успел написать боту (known_users), с тегом по id вместо @username.
// Пример: /all Го играть через 10 минут!
function handleTagAll(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может тегать всех.");

  const customText = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
  const header = customText ? `📣 ${escapeHtml(customText)}\n\n` : "📣 Внимание всем:\n\n";

  const tagList = db.prepare("SELECT usernames FROM tag_lists WHERE chat_id=?").get(ctx.chat.id);

  let mentions;
  if (tagList && tagList.usernames) {
    const usernames = tagList.usernames.split("\n").filter(Boolean);
    mentions = usernames.map((u) => `@${u}`);
  } else {
    const users = db.prepare("SELECT user_id, name FROM known_users WHERE chat_id=?").all(ctx.chat.id);
    if (!users.length) {
      return ctx.reply(
        "Никого нет ни в списке юзернеймов, ни среди тех, кто писал боту.\n" +
          "Задайте список вручную: /set_all_usernames vasya, petya123\n" +
          "или дождитесь, пока люди сами напишут боту любую команду."
      );
    }
    mentions = users.map((u) => `<a href="tg://user?id=${u.user_id}">${escapeHtml(u.name)}</a>`);
  }

  // На случай очень большого чата — режем на пачки по 50 упоминаний на сообщение
  const CHUNK = 50;
  for (let i = 0; i < mentions.length; i += CHUNK) {
    const chunk = mentions.slice(i, i + CHUNK).join(" ");
    ctx.reply((i === 0 ? header : "") + chunk, { parse_mode: "HTML" });
  }
}

bot.command("all", handleTagAll);
bot.hears(/^\/все(?:@\w+)?(?=\s|$)/i, handleTagAll);

// --- Админ: лобби ---

bot.command("create_lobby", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может создавать лобби.");

  const existing = getActiveLobby(ctx.chat.id);
  if (existing) {
    return replyPrivately(
      ctx,
      `Уже есть открытое лобби #${existing.id}. Сначала закройте его: /close_lobby`
    );
  }

  const info = db
    .prepare(
      "INSERT INTO lobbies (chat_id, title, status, created_by, created_at) VALUES (?,?,?,?,?)"
    )
    .run(ctx.chat.id, "", "open", ctx.from.id, nowIso());

  await replyPrivately(
    ctx,
    `✅ Лобби #${info.lastInsertRowid} открыто.\nПишите /bet <сумма>, например: /bet 100`
  );

  // Публичное объявление для всех — без деталей, просто что приём ставок открыт
  const announcement = await ctx.telegram.sendMessage(
    ctx.chat.id,
    `✅ Приём ставок открыт!\nСтавьте командой /bet <сумма> или кнопками ниже 👇`,
    quickBetKeyboard()
  );

  // Закрепляем сообщение, чтобы кнопки было легко найти даже после того, как чат
  // уйдёт далеко вперёд. Если у бота нет прав на закрепление — просто пропускаем.
  try {
    await ctx.telegram.pinChatMessage(ctx.chat.id, announcement.message_id, {
      disable_notification: true,
    });
    db.prepare("UPDATE lobbies SET pinned_message_id=? WHERE id=?").run(
      announcement.message_id,
      info.lastInsertRowid
    );
  } catch (e) {
    // бот не админ группы или права на закрепление не выданы — не критично
  }
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
    `🔒 Лобби #${lobby.id} закрыто.\n` +
      `Не забудьте зафиксировать результаты: /result <bet_id> creator|opponent`
  );

  // Открепляем сообщение с кнопками ставок, если оно было закреплено
  if (lobby.pinned_message_id) {
    try {
      await ctx.telegram.unpinChatMessage(ctx.chat.id, { message_id: lobby.pinned_message_id });
    } catch (e) {
      // не критично, если не получилось
    }
  }

  await ctx.telegram.sendMessage(ctx.chat.id, `🔒 Приём ставок закрыт!`);
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

// Админ добавляет ставку вручную (например, если игроки договорились прямо во
// время игры, минуя /bet и /accept). Игрок указывается через @username или
// числовой id. Создаётся сразу как "matched" — результат потом через /result.
bot.command("add_bet", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может добавлять ставки за игроков.");

  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 4) {
    return replyPrivately(
      ctx,
      "Использование: /add_bet <игрок1> <игрок2> <сумма>\n" +
        "Игрок — @username или числовой id (id узнать через /debts, если человек уже писал боту).\n" +
        "Пример: /add_bet @vasya @petya 100"
    );
  }

  const [, p1raw, p2raw, amountRaw] = args;
  const amount = parseFloat(amountRaw.replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    return replyPrivately(ctx, "Сумма должна быть положительным числом.");
  }

  const lobby = getActiveLobby(ctx.chat.id);
  if (!lobby) return replyPrivately(ctx, "Нет открытого лобби — сначала /create_lobby.");

  const p1 = resolveUser(ctx.chat.id, p1raw);
  const p2 = resolveUser(ctx.chat.id, p2raw);

  if (!p1 || !p2) {
    return replyPrivately(
      ctx,
      "Не удалось определить одного из игроков по юзернейму. " +
        "Попросите его один раз написать боту что угодно (например /help) — после этого бот его узнает, " +
        "либо укажите числовой id напрямую."
    );
  }
  if (p1.id === p2.id) return replyPrivately(ctx, "Игроки должны быть разными.");

  const info = db
    .prepare(
      `INSERT INTO bets (lobby_id, creator_id, creator_name, amount, status, opponent_id, opponent_name, matched_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(lobby.id, p1.id, p1.name, amount, "matched", p2.id, p2.name, nowIso(), nowIso());

  await replyPrivately(
    ctx,
    `✅ Ставка #${info.lastInsertRowid} добавлена вручную: ${p1.name} vs ${p2.name}, ${amount.toFixed(2)}$.\n` +
      `Когда узнаете исход: /result ${info.lastInsertRowid} creator|opponent`
  );
});

// Редактирование уже существующей ставки — сумма или один из участников
// (пригодится, когда игроки переделили ставки между собой прямо во время игры).
bot.command("edit_bet", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может редактировать ставки.");

  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 4 || !/^\d+$/.test(args[1]) || !["amount", "creator", "opponent"].includes(args[2])) {
    return replyPrivately(
      ctx,
      "Использование: /edit_bet <bet_id> <amount|creator|opponent> <новое значение>\n\n" +
        "Примеры:\n" +
        "/edit_bet 7 amount 150\n" +
        "/edit_bet 7 creator @vasya\n" +
        "/edit_bet 7 opponent 123456789"
    );
  }

  const betId = Number(args[1]);
  const field = args[2];
  const value = args[3];

  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);
  if (!bet) return replyPrivately(ctx, "Ставка не найдена.");
  if (bet.status === "settled") {
    return replyPrivately(
      ctx,
      "Эта ставка уже завершена (результат зафиксирован) — редактировать нельзя. " +
        "Можно удалить (/del_bet) и добавить заново (/add_bet)."
    );
  }

  if (field === "amount") {
    const amount = parseFloat(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      return replyPrivately(ctx, "Сумма должна быть положительным числом.");
    }
    db.prepare("UPDATE bets SET amount=? WHERE id=?").run(amount, betId);
    return replyPrivately(ctx, `✅ Ставка #${betId}: сумма изменена на ${amount.toFixed(2)}$.`);
  }

  const player = resolveUser(ctx.chat.id, value);
  if (!player) {
    return replyPrivately(
      ctx,
      "Не удалось определить игрока по юзернейму. Попросите его написать боту что угодно один раз, " +
        "либо укажите числовой id напрямую."
    );
  }

  if (field === "creator") {
    db.prepare("UPDATE bets SET creator_id=?, creator_name=? WHERE id=?").run(player.id, player.name, betId);
  } else {
    db.prepare("UPDATE bets SET opponent_id=?, opponent_name=? WHERE id=?").run(player.id, player.name, betId);
  }

  await replyPrivately(
    ctx,
    `✅ Ставка #${betId}: ${field === "creator" ? "создатель" : "принявший"} изменён на ${player.name}.`
  );
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

  const winnerId = winner === "creator" ? bet.creator_id : bet.opponent_id;
  const winnerName = winner === "creator" ? bet.creator_name : bet.opponent_name;
  const commission = Math.round(bet.amount * COMMISSION_RATE * 100) / 100;

  db.prepare(
    `INSERT INTO commissions (chat_id, bet_id, user_id, user_name, amount, paid, created_at)
     VALUES (?,?,?,?,?,0,?)`
  ).run(ctx.chat.id, betId, winnerId, winnerName, commission, nowIso());

  await replyPrivately(
    ctx,
    `✅ Ставка #${betId} завершена. Победитель: ${winnerName}\n` +
      `💵 Комиссия админу (${(COMMISSION_RATE * 100).toFixed(0)}%): ${commission.toFixed(2)}$ — записана в /debts`
  );
});

bot.command("export", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может выгружать историю.");

  const rows = db
    .prepare(
      `SELECT b.* FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? ORDER BY b.id`
    )
    .all(ctx.chat.id);

  const header = "bet_id,lobby_id,creator,opponent,amount,status,winner,created_at,matched_at\n";
  const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = rows
    .map((r) =>
      [
        r.id,
        r.lobby_id,
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
bot.hears(/^\/составы(?:@\w+)?(?=\s|$)/i, showLineup);

const ADMIN_WALLET = "TYDpL8JRcAPJuVpimbFrh7LFusJ7bfzWkB";

bot.hears(/^\/комса(?:@\w+)?(?=\s|$)/i, (ctx) => {
  ctx.reply(`💳 Кошелёк для расчётов:\n\`${ADMIN_WALLET}\``, { parse_mode: "Markdown" });
});

// --- Обработчики инлайн-кнопок ---

bot.action(/^quickbet:(\d+)$/, async (ctx) => {
  const amount = Number(ctx.match[1]);
  const result = createBet(ctx.chat.id, ctx.from.id, userDisplayName(ctx.from), amount);

  if (!result.ok) {
    return ctx.answerCbQuery(result.error, { show_alert: true });
  }

  await ctx.answerCbQuery(`Ставка ${amount}$ создана ✅`);
  await ctx.reply(
    `💰 Ставка #${result.betId} создана: ${ctx.from.first_name} ставит ${amount.toFixed(2)}$ на себя.`,
    acceptKeyboard(result.betId)
  );
});

bot.action(/^accept:(\d+)$/, async (ctx) => {
  const betId = Number(ctx.match[1]);
  const result = acceptBet(betId, ctx.from.id, userDisplayName(ctx.from));

  if (!result.ok) {
    return ctx.answerCbQuery(result.error, { show_alert: true });
  }

  await ctx.answerCbQuery("Ставка принята! 🤝");
  try {
    // Убираем кнопку и обновляем текст исходного сообщения о ставке
    await ctx.editMessageText(result.text);
  } catch (e) {
    // если не удалось отредактировать (например, сообщение слишком старое) —
    // просто отправляем новое
    await ctx.reply(result.text);
  }
});

// --- Пользователи: ставки ---

function handleBetCommand(ctx) {
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 2) return ctx.reply("Использование: /bet 100 (или /ставка 100)");

  const amount = parseFloat(parts[1].replace(",", "."));
  const result = createBet(ctx.chat.id, ctx.from.id, userDisplayName(ctx.from), amount);

  if (!result.ok) return ctx.reply(result.error + " Пример: /bet 100");

  ctx.reply(
    `💰 Ставка #${result.betId} создана: ${ctx.from.first_name} ставит ${amount.toFixed(2)}$ на себя.`,
    acceptKeyboard(result.betId)
  );
}

bot.command("bet", handleBetCommand);
bot.hears(/^\/ставка(?:@\w+)?(?=\s|$)/i, handleBetCommand);

bot.command("cancel", (ctx) => {
  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    return ctx.reply("Использование: /cancel <bet_id>");
  }

  const betId = Number(args[1]);
  const bet = db.prepare("SELECT * FROM bets WHERE id=?").get(betId);

  if (!bet) return ctx.reply("Ставка не найдена.");

  const isCreator = bet.creator_id === ctx.from.id;
  const isOpponent = bet.opponent_id === ctx.from.id;

  if (!isCreator && !isOpponent) {
    return ctx.reply("Отменить можно только ставку, в которой вы участвуете.");
  }
  if (bet.status === "settled") {
    return ctx.reply("Эта ставка уже завершена (результат зафиксирован) — отменить нельзя. Обратитесь к админу.");
  }
  if (bet.status === "cancelled") {
    return ctx.reply("Эта ставка уже отменена.");
  }
  if (bet.status === "open" && !isCreator) {
    // теоретически недостижимо (opponent_id ещё не задан), но на всякий случай
    return ctx.reply("Эту ставку ещё никто не принял — отменить может только её создатель.");
  }

  db.prepare("UPDATE bets SET status='cancelled' WHERE id=?").run(betId);

  const who = userDisplayName(ctx.from);
  const otherName = isCreator ? bet.opponent_name : bet.creator_name;
  ctx.reply(
    `🗑 Ставка #${betId} отменена (${who}).` +
      (otherName ? ` ${otherName}, учтите — ставка больше не действует.` : "")
  );
});

bot.command("accept", (ctx) => {
  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    return ctx.reply("Использование: /accept <bet_id>");
  }

  const betId = Number(args[1]);
  const result = acceptBet(betId, ctx.from.id, userDisplayName(ctx.from));

  if (!result.ok) return ctx.reply(result.error);
  ctx.reply(result.text);
});

function handleBetsCommand(ctx) {
  const lobby = getActiveLobby(ctx.chat.id);
  let rows, header;

  if (lobby) {
    rows = db.prepare("SELECT * FROM bets WHERE lobby_id=? ORDER BY id").all(lobby.id);
    header = `📋 Лобби #${lobby.id}\n\n`;
  } else {
    const last = db
      .prepare("SELECT * FROM lobbies WHERE chat_id=? ORDER BY id DESC LIMIT 1")
      .get(ctx.chat.id);
    if (!last) return ctx.reply("Пока нет ни одного лобби.");
    rows = db.prepare("SELECT * FROM bets WHERE lobby_id=? ORDER BY id").all(last.id);
    header = `📋 Лобби #${last.id} — закрыто\n\n`;
  }

  if (rows.length === 0) return ctx.reply(header + "Ставок пока нет.");

  const openBets = rows.filter((r) => r.status === "open");
  const matchedBets = rows.filter((r) => r.status === "matched");
  const settledBets = rows.filter((r) => r.status === "settled");

  let text = header;
  if (openBets.length) text += "🟢 Открытые ставки:\n" + openBets.map(fmtBet).join("\n") + "\n\n";
  if (matchedBets.length) text += "🔵 Активные ставки:\n" + matchedBets.map(fmtBet).join("\n") + "\n\n";
  if (settledBets.length) text += "✅ Завершённые:\n" + settledBets.map(fmtBet).join("\n");

  // Кнопки принятия — только для чужих открытых ставок
  const acceptButtons = openBets
    .filter((b) => b.creator_id !== ctx.from.id)
    .map((b) => [Markup.button.callback(`Принять #${b.id} (${b.amount.toFixed(0)}$)`, `accept:${b.id}`)]);

  ctx.reply(text.trim(), acceptButtons.length ? Markup.inlineKeyboard(acceptButtons) : undefined);
}

bot.command("bets", handleBetsCommand);
bot.hears(/^\/ставки(?:@\w+)?(?=\s|$)/i, handleBetsCommand);

// ---------- Лидерборд и бейджи ----------

function getLeaderboard(chatId) {
  const rows = db
    .prepare(
      `SELECT b.* FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? AND b.status='settled'`
    )
    .all(chatId);

  const stats = new Map(); // userId -> { id, name, wins, losses, net }

  const touch = (id, name) => {
    if (!stats.has(id)) stats.set(id, { id, name, wins: 0, losses: 0, net: 0 });
    return stats.get(id);
  };

  for (const r of rows) {
    const creator = touch(r.creator_id, r.creator_name);
    const opponent = touch(r.opponent_id, r.opponent_name);

    if (r.winner === "creator") {
      creator.wins += 1;
      creator.net += r.amount;
      opponent.losses += 1;
      opponent.net -= r.amount;
    } else {
      opponent.wins += 1;
      opponent.net += r.amount;
      creator.losses += 1;
      creator.net -= r.amount;
    }
  }

  return [...stats.values()].sort((a, b) => b.net - a.net);
}

// Порядок результатов (побед/поражений) конкретного игрока в хронологии — для стриков
function getUserResultsOrdered(chatId, userId) {
  const rows = db
    .prepare(
      `SELECT b.* FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? AND b.status='settled' AND (b.creator_id=? OR b.opponent_id=?)
       ORDER BY b.id`
    )
    .all(chatId, userId, userId);

  return rows.map(
    (r) =>
      (r.winner === "creator" && r.creator_id === userId) ||
      (r.winner === "opponent" && r.opponent_id === userId)
  );
}

// Текущая (последняя) серия одинаковых исходов подряд
function trailingStreak(boolArray) {
  if (!boolArray.length) return { win: null, len: 0 };
  const last = boolArray[boolArray.length - 1];
  let len = 0;
  for (let i = boolArray.length - 1; i >= 0; i--) {
    if (boolArray[i] === last) len++;
    else break;
  }
  return { win: last, len };
}

function getUserMaxBet(chatId, userId) {
  const row = db
    .prepare(
      `SELECT MAX(b.amount) as maxAmt FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? AND (b.creator_id=? OR b.opponent_id=?) AND b.status!='cancelled'`
    )
    .get(chatId, userId, userId);
  return row && row.maxAmt ? row.maxAmt : 0;
}

// Суммы всех ставок игрока в хронологии — для бейджа "Мелочёвка"
function getUserAmountsOrdered(chatId, userId) {
  return db
    .prepare(
      `SELECT b.amount FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? AND (b.creator_id=? OR b.opponent_id=?) AND b.status!='cancelled'
       ORDER BY b.id`
    )
    .all(chatId, userId, userId)
    .map((r) => r.amount);
}

function trailingSmallStreak(amounts, threshold) {
  let len = 0;
  for (let i = amounts.length - 1; i >= 0; i--) {
    if (amounts[i] <= threshold) len++;
    else break;
  }
  return len;
}

// Возвращает массив бейджей (строк с эмодзи+названием), которые заслужил игрок
function getUserBadges(chatId, userId) {
  const badges = [];

  const results = getUserResultsOrdered(chatId, userId);
  const streak = trailingStreak(results);
  if (streak.win === true) {
    if (streak.len >= 5) badges.push("🚀 Неудержимый");
    else if (streak.len >= 3) badges.push("🔥 На стрике");
  } else if (streak.win === false) {
    if (streak.len >= 5) badges.push("⚰️ Дно пробито");
    else if (streak.len >= 3) badges.push("💀 Чёрная полоса");
  }

  const maxBet = getUserMaxBet(chatId, userId);
  if (maxBet >= 1000) badges.push("🎩 Ва-банк");
  else if (maxBet >= 500) badges.push("🐳 Крупная рыба");

  const amounts = getUserAmountsOrdered(chatId, userId);
  if (trailingSmallStreak(amounts, 100) >= 5) badges.push("🪙 Мелочёвка");

  const board = getLeaderboard(chatId);
  if (board.length > 1) {
    const idx = board.findIndex((s) => s.id === userId);
    if (idx === 0 && board[0].net > 0) badges.push("👑 Король банка");
    if (idx === board.length - 1 && board[idx].net < 0) badges.push("🤡 Спонсор чата");
  }
  const me = board.find((s) => s.id === userId);
  if (me && Math.abs(me.net) <= 10 && me.wins + me.losses >= 10) badges.push("⚖️ В нуле");

  return badges;
}

const BADGES_HELP =
  "🏅 Бейджи бота\n\n" +
  "🔥 На стрике — 3+ победы подряд\n" +
  "🚀 Неудержимый — 5+ побед подряд\n" +
  "💀 Чёрная полоса — 3+ поражения подряд\n" +
  "⚰️ Дно пробито — 5+ поражений подряд\n\n" +
  "🐳 Крупная рыба — хотя бы одна ставка от 500$\n" +
  "🎩 Ва-банк — хотя бы одна ставка от 1000$\n" +
  "🪙 Мелочёвка — 5+ последних ставок подряд не крупнее 100$\n\n" +
  "👑 Король банка — #1 в /top по балансу\n" +
  "🤡 Спонсор чата — последнее место в /top с отрицательным балансом\n" +
  "⚖️ В нуле — баланс от -10$ до +10$ при 10+ сыгранных ставках\n\n" +
  "Бейджи считаются автоматически и видны в /mystats и /top.";

bot.command("badges", (ctx) => ctx.reply(BADGES_HELP));
bot.hears(/^\/бейджи(?:@\w+)?(?=\s|$)/i, (ctx) => ctx.reply(BADGES_HELP));

bot.command("top", (ctx) => {
  const sorted = getLeaderboard(ctx.chat.id);

  if (sorted.length === 0) {
    return ctx.reply("Пока нет ни одной завершённой ставки — рейтинг пуст.");
  }

  const lines = sorted.map((s, i) => {
    const place = ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    const sign = s.net >= 0 ? "+" : "";
    const badges = getUserBadges(ctx.chat.id, s.id);
    const badgesText = badges.length ? ` ${badges.map((b) => b.split(" ")[0]).join("")}` : "";
    return `${place} ${s.name}${badgesText} — ${s.wins}W/${s.losses}L, баланс: ${sign}${s.net.toFixed(2)}$`;
  });

  ctx.reply(`🏆 Общий рейтинг чата\n\n${lines.join("\n")}`);
});

function handleDebts(ctx) {
  const rows = db
    .prepare(
      `SELECT user_id, user_name, SUM(amount) as total FROM commissions
       WHERE chat_id=? AND paid=0 GROUP BY user_id ORDER BY total DESC`
    )
    .all(ctx.chat.id);

  if (rows.length === 0) {
    return ctx.reply("💵 Долгов по комиссии нет — все чисто.");
  }

  const lines = rows.map((r) => `• ${r.user_name} — ${r.total.toFixed(2)}$ (id: ${r.user_id})`);
  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  ctx.reply(
    `💵 Долги по комиссии админу (${(COMMISSION_RATE * 100).toFixed(0)}% с выигрыша):\n\n` +
      lines.join("\n") +
      `\n\nИтого: ${grandTotal.toFixed(2)}$`
  );
}

bot.command("debts", handleDebts);
bot.hears(/^\/долги(?:@\w+)?(?=\s|$)/i, handleDebts);

// Админ отмечает, что человек рассчитался — закрывает все его текущие долги по комиссии
bot.command("paid", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Только админ может отмечать оплату.");

  const args = ctx.message.text.split(/\s+/);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    return replyPrivately(
      ctx,
      "Использование: /paid <user_id>\nId участника видно в /debts рядом с именем."
    );
  }

  const userId = Number(args[1]);
  const info = db
    .prepare(
      `UPDATE commissions SET paid=1, paid_at=? WHERE chat_id=? AND user_id=? AND paid=0`
    )
    .run(nowIso(), ctx.chat.id, userId);

  if (info.changes === 0) {
    return replyPrivately(ctx, "У этого пользователя нет неоплаченных долгов.");
  }

  await replyPrivately(ctx, `✅ Долг по комиссии закрыт для id ${userId} (${info.changes} записей).`);
});

bot.command("mystats", (ctx) => {
  const userId = ctx.from.id;
  const rows = db
    .prepare(
      `SELECT b.* FROM bets b
       JOIN lobbies l ON l.id = b.lobby_id
       WHERE l.chat_id=? AND b.status='settled' AND (b.creator_id=? OR b.opponent_id=?)`
    )
    .all(ctx.chat.id, userId, userId);

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

  const badges = getUserBadges(ctx.chat.id, userId);
  const badgesText = badges.length ? `\n\n🏅 Бейджи:\n${badges.join("\n")}` : "";

  ctx.reply(
    `📊 Статистика ${ctx.from.first_name}\n` +
      `Побед: ${wins}\nПоражений: ${losses}\nБаланс: ${net >= 0 ? "+" : ""}${net.toFixed(2)}$` +
      badgesText
  );
});

bot.launch().then(() => console.log("Бот запущен"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
