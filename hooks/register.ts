import type { EngineInterface, Register, Timer } from 'claude-code'

/**
 * Мод моста Telegram: держит соединение сессии со службой, подаёт слово владельца в сессию новым
 * ходом, исполняет команду из темы и называет службе границы хода и долю занятого окна контекста.
 *
 * Сокетов у модуля хуков нет вовсе, поэтому соединение сессии держит подкоманда
 * `telegram-bridge link`: доставку она отдаёт строкой JSON своей стандартной выдачи, а короткий
 * запрос принимает на свой местный вход, который называет событием `ready`: сокетом (`socket`)
 * или петлевым адресом с ключом (`url` и `token`) — тем, что есть на её площадке. Протокол и роли
 * — контракт службы `telegram-bridge`; служба в этом репозитории не публикуется.
 */

/** Адрес местного входа-сокета: имя хоста здесь роли не играет, запрос идёт в сокет. */
const FRONT = 'http://telegram-bridge'

/**
 * Как часто мод заглядывает в журнал сессии за названием чата: о `/rename` движок модулю не
 * сообщает ничем, и переименование видно только записью журнала.
 */
const TITLE_POLL_MS = 5000

/** Пути местного входа — по одному на операцию. Те же пути зовёт плагин OpenCode. */
const PATH_ACK = '/ack'
const PATH_BYE = '/bye'
const PATH_TURN_START = '/turn/start'
const PATH_TURN_END = '/turn/end'
const PATH_CONTEXT = '/context'
const PATH_MESSAGE = '/message'
const PATH_NAME = '/name'

/**
 * Имя бинаря моста в `PATH`. Путь к нему перебивает переменная окружения `DM_TELEGRAM_BRIDGE`;
 * имя переменной пишется литералом в месте чтения, иначе клиент не перечислит, что модуль читает
 * из окружения.
 */
const BINARY = 'telegram-bridge'

/**
 * Имена команд режима, которые регистрирует мод. Клиент зовёт их `/<имя>`: имя регистрации — само
 * название команды, без имени плагина впереди (`/away`, `/here`), и оно же — имя в хуке
 * `command.run`. Те же две команды у плагина OpenCode: владелец набирает одно и то же в обоих
 * клиентах.
 */
const COMMAND_AWAY = 'away'
const COMMAND_HERE = 'here'

/** Событие подкоманды `link`: один объект JSON в строке её стандартной выдачи. */
type Linked = {
  event?: string
  socket?: string
  url?: string
  token?: string
  kind?: string
  delivery_id?: string
  text?: string
  provenance?: string
  code?: string
}

/** Исход подачи доставки в сессию: честь или придержанное слово. */
type Outcome = 'accepted' | 'rejected'

/** Ответ местного входа подкоманды: удача или отказ службы со своим кодом. */
type Answered = { ok: boolean; status: number; text: string }

/**
 * Местный вход подкоманды, как она назвала его событием `ready`: сокет там, где он есть (macOS), и
 * петлевой адрес с ключом там, где запрос модуля в именованный канал движок не пускает (Windows).
 */
type Front = { socket: string } | { url: string; token: string }

/**
 * Вход текущей подкоманды. Свой у каждого запуска модуля: перезапуск мода поднимает своё
 * соединение и свой вход.
 */
let front: Front | undefined

/**
 * Пауза перед новым запуском подкоманды, которая вышла не по `bye` и не отказом службы. Связь со
 * службой подкоманда держит сама и в том же процессе; новый запуск нужен только тогда, когда сам
 * процесс кончился — его убили или он упал.
 */
const RESPAWN_PAUSE_MS = 5000

/**
 * Владельцу о пропавшем канале уже сказано: второй раз одно и то же не говорится, а вернувшееся
 * соединение снимает сказанное.
 */
let spoken = false

/**
 * Подкоманда этого запуска сказала `error`: отказ, после которого новый запуск не поможет, —
 * чужая версия контракта или вытеснённое соединение сессии. Поднимать её заново нельзя: второй
 * держатель отбирал бы сессию у первого по кругу.
 */
let refused = false

/** Подкоманда идёт: второй держатель сессии рядом с живым не поднимается. */
let alive = false

/** Подкоманда хоть раз открыла соединение: о репликах, не дождавшихся её, есть что сказать. */
let everOpened = false

/** Сессия, которую держит подкоманда: `/resume` внутри процесса меняет её на другую. */
let linkedSession: string | undefined

/** Цикл текущей подкоманды: перепривязка к другой сессии дожидается его конца. */
let holding: Promise<void> | undefined

/** Отложенный подъём подкоманды: снимается новым стартом и концом сессии. */
let respawning: Timer | undefined

/**
 * Этот запуск подкоманды — подъём после смерти прежней, о которой владельцу сказано «поднимаю
 * заново»: не открыл он соединение — владелец узнаёт и об этом, а не остаётся с обещанием.
 */
let revival = false

/**
 * Доставки, которые мод уже подал и принял. Служба подаёт запись заново, пока не услышала
 * подтверждения, — после перезапуска службы или подкоманды посреди подачи. Повтор не подаётся в
 * сессию второй раз: мод подтверждает его принятым и только.
 */
const accepted = new Set<string>()

/** Сколько принятых доставок мод помнит: повтор приходит сразу за перезапуском, а не через сотни. */
const ACCEPTED_KEPT = 256

/**
 * Реплики агента, пришедшие, пока подкоманды нет между смертью и подъёмом: они уходят новой
 * подкоманде, как только она откроет вход, в порядке прихода.
 */
const waiting: string[] = []

/** Сколько реплик мод копит без подкоманды; сверх — старейшая теряется, и владелец узнаёт. */
const WAITING_KEPT = 64

/**
 * Почему соединения сессии нет. Мост на машине может быть не настроен вовсе, и строка об этом в
 * каждом чате владельцу ни к чему: он узнаёт причину, когда просит режим, ответом `/away`.
 */
let absent: string | undefined

/**
 * Название чата, как его последним назвал клиент, и то, какое из названий уже ушло службе на этом
 * соединении. Служба держит название у себя: имя темы без аргумента берётся из него, а пока оно
 * меняется — тема переименовывается.
 */
let chat = ''
let named = ''

/**
 * Откуда приходит название чата: вход классического хука (`session_title`) и журнал сессии
 * (`custom-title`, иначе `ai-title`). Каждый источник помнит, что назвал последним, и названием
 * чата становится то, что сменилось позже: источник, повторяющий прежнее, свежего не перебивает.
 */
type Source = 'hook' | 'journal'

const heard: Record<Source, string> = { hook: '', journal: '' }

/**
 * Журнал сессии (JSONL) — путь из входа классического хука — и метка (размер и время правки), на
 * которой он прочитан последним: неизменный журнал второй раз не читается.
 */
let journal: string | undefined
let journalMark = ''

/** Чтение журнала идёт: опрос не начинает второе рядом с ним, а ждёт того же. */
let peeking: Promise<void> | undefined

/** Опрос журнала: идёт, пока жива сессия, и снимается её концом. */
let polling: Timer | undefined

/**
 * Имя, которое `/away <имя>` дало чату: ближайший `UserPromptSubmit` отдаёт его клиенту полем
 * `sessionTitle` один раз — у ответа `command.run` такого поля нет.
 */
let retitle: string | undefined

/** reason называет причину отказа строкой, годной для журнала службы. */
const reason = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

/**
 * said говорит владельцу о мосте тем, чем мод вообще говорит в терминале. Зовётся он там, где
 * канала не стало: иначе владелец читал бы об этом только в журнале отладки, а в теме видел бы
 * отметку придержанного на своём сообщении и больше ничего.
 */
const said = ($: EngineInterface, line: string): void => {
  const text = `мост Telegram: ${line}`

  spoken = true

  $.ui.toast(text)
  $.ui.status(text)
  $.ui.log(text, { to: 'transcript' })
}

/**
 * unlinked запоминает, почему соединения нет, и не тревожит владельца: режим он не просил.
 * Первая названная причина точнее той, что придёт следом с концом подкоманды.
 */
const unlinked = ($: EngineInterface, line: string): void => {
  absent ??= line

  $.ui.log(`мост Telegram: ${line}`, { to: 'debug' })
}

/**
 * restored говорит владельцу, что канал вернулся, — только если до этого ему было сказано, что
 * канала нет: штатный перезапуск службы проходит молча, и возврата тогда не говорится.
 */
const restored = ($: EngineInterface): void => {
  if (!spoken) {
    return
  }

  spoken = false

  const text = 'мост Telegram: канал вернулся'

  $.ui.toast(text)
  $.ui.status(undefined)
  $.ui.log(text, { to: 'transcript' })
}

/**
 * warned говорит владельцу о потере, которая случилась один раз и сама не вернётся: реплика агента,
 * не дошедшая до темы. Отметки «сказано» не ставит — это не состояние канала.
 */
const warned = ($: EngineInterface, line: string): void => {
  const text = `мост Telegram: ${line}`

  $.ui.toast(text)
  $.ui.log(text, { to: 'transcript' })
}

/** remember запоминает принятую доставку, держа список в пределе. */
const remember = (delivery: string): void => {
  accepted.add(delivery)

  if (accepted.size > ACCEPTED_KEPT) {
    const oldest = accepted.values().next().value

    if (oldest !== undefined) {
      accepted.delete(oldest)
    }
  }
}

/** head отрезает у строки команды имя: всё после первого пробела — её аргументы. */
const head = (line: string): { name: string; args: string } => {
  const body = line.trim().replace(/^\/+/, '')
  const gap = body.search(/\s/)

  return gap === -1
    ? { name: body, args: '' }
    : { name: body.slice(0, gap), args: body.slice(gap + 1).trim() }
}

/**
 * post зовёт местный вход подкоманды тем путём, который она назвала сама: петлевой адрес несёт
 * ключ заголовком `Authorization`, сокет ключа не требует. Вход — довод звонящего: входа может не
 * быть вовсе, и решает это тот, кто знает, что делать без него.
 */
const post = async (
  $: EngineInterface,
  door: Front,
  path: string,
  body: unknown,
): Promise<Answered> => {
  const payload = JSON.stringify(body)
  const answered =
    'url' in door
      ? await $.http.fetch(`${door.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${door.token}` },
          body: payload,
        })
      : await $.http.fetch(`${FRONT}${path}`, {
          method: 'POST',
          socketPath: door.socket,
          headers: { 'content-type': 'application/json' },
          body: payload,
        })

  return { ok: answered.ok, status: answered.status, text: answered.text }
}

/**
 * opened разбирает вход из события `ready`: петлевой адрес, когда подкоманда назвала и его, и
 * ключ, иначе сокет. Не назвала ни того, ни другого — входа нет.
 */
const opened = (event: Linked): Front | undefined => {
  if (event.url !== undefined && event.url !== '' && event.token !== undefined && event.token !== '') {
    return { url: event.url, token: event.token }
  }

  if (event.socket !== undefined && event.socket !== '') {
    return { socket: event.socket }
  }

  return undefined
}

/** where называет вход строкой для журнала отладки — без ключа. */
const where = (door: Front): string => ('url' in door ? door.url : door.socket)

/**
 * Подтверждение приёма: по нему служба ставит честь на сообщении владельца. Отправка доставки
 * приёмом не считается, поэтому зовётся оно только после того, как подача разрешилась.
 */
const confirm = async (
  $: EngineInterface,
  delivery: string,
  outcome: Outcome,
  detail: string,
): Promise<void> => {
  const door = front

  // Подкоманды нет — она умерла посреди подачи. Служба подаст запись заново новой подкоманде, и
  // повтор принятой подтвердится без второй подачи (`accepted`).
  if (door === undefined) {
    $.ui.log(`приём ${delivery} подтверждать некуда: подкоманды нет, подтвердится на повторе`, {
      to: 'debug',
    })

    return
  }

  // Отказ подтверждения — рабочее состояние протокола, а не исключение: рвать им единственный
  // цикл чтения доставок нельзя, иначе клиент погасит дочерний процесс вместе с каналом.
  try {
    const answered = await post($, door, PATH_ACK, { delivery_id: delivery, outcome, detail })

    if (!answered.ok) {
      // Служба отказала: слово владельца осталось придержанным, и он видит это отметкой
      // придержанного на своём сообщении. О конце самого соединения скажет событие `error` — оно
      // идёт тем же отказом.
      $.ui.log(`приём ${delivery} не подтверждён: ${answered.status} ${answered.text}`, {
        to: 'debug',
      })
    }
  } catch (failure) {
    said($, `приём ${delivery} не дошёл, канала нет: ${reason(failure)}`)
  }
}

/**
 * notice извещает службу о границе хода и о проценте контекста. Ход этим не держится: ответа
 * извещение по контракту не ждёт, поэтому оно уходит без ожидания, а отказ уезжает в журнал
 * отладки — канала может не быть вовсе, и ронять им ход нельзя. Ждать извещение может тот, кому
 * нужен его исход раньше своего шага (`/away` после имени): отказом оно не кончается никогда.
 */
const notice = ($: EngineInterface, path: string, body: unknown): Promise<void> => {
  const door = front

  if (door === undefined) {
    return Promise.resolve()
  }

  return post($, door, path, body)
    .then((answered: Answered) => {
      if (!answered.ok) {
        $.ui.log(`${path}: служба отказала ${answered.status} ${answered.text}`, { to: 'debug' })
      }
    })
    .catch((failure: unknown) => {
      $.ui.log(`${path} не дошёл: ${reason(failure)}`, { to: 'debug' })
    })
}

/**
 * context называет службе долю занятого окна контекста. Своего счёта мод не ведёт: число знает
 * клиент, у которого окно и считается, а мод его только проводит. Числа у клиента нет (модели без
 * ответа, окно неизвестно) — извещения нет вовсе: править строку состояния нулём значило бы
 * соврать о контексте.
 */
const context = async ($: EngineInterface): Promise<void> => {
  if (front === undefined) {
    return
  }

  const usage = await $.session.usage()
  const share = usage.context.percent

  if (share === undefined || !Number.isFinite(share)) {
    return
  }

  void notice($, PATH_CONTEXT, { percent: share })
}

/**
 * reply отдаёт службе дописанную реплику агента целиком. Шага хода она не держит: извещение
 * уходит без ожидания, как границы хода и процент, — отправка в тему идёт своим ходом, и отказ
 * канала уезжает в журнал отладки.
 *
 * Дописанность мерится концом ответа, а не наличием текста. `stopReason` равен `null`, когда
 * ответа не пришло вовсе: запрос отказал или его прервали до конца сообщения. Текст у такого шага
 * бывает — ровно столько, сколько модель успела написать до Escape, — и в тему он не идёт:
 * прерванная на середине реплика дописанной не является. Так же ведёт себя сторона OpenCode, где
 * события конца на незакрытый блок текста не приходит вовсе.
 */
const reply = ($: EngineInterface, answered: { answer: string; stopReason: unknown }): void => {
  if (answered.stopReason === null) {
    return
  }

  const text = answered.answer.trim()

  // Шаг без видимого текста — только вызовы инструментов или только мысли: отправлять нечего, а
  // пустого сообщения Bot API и не примет.
  if (text === '') {
    return
  }

  // Входа подкоманды нет: она поднимается заново (таймер ещё идёт или уже сработал, а `ready`
  // не пришёл) — реплика ждёт её входа, а не теряется молча.
  if (front === undefined && (respawning !== undefined || alive)) {
    waiting.push(text)

    if (waiting.length > WAITING_KEPT) {
      waiting.shift()
      warned($, 'реплика агента не дошла до темы: подкоманды моста нет, а копится не больше 64')
    }

    return
  }

  void notice($, PATH_MESSAGE, { text })
}

/** release отдаёт новой подкоманде реплики, накопленные без неё, в порядке прихода. */
const release = ($: EngineInterface): void => {
  for (const text of waiting.splice(0)) {
    void notice($, PATH_MESSAGE, { text })
  }
}

/** told называет процент, не держа ход и не роняя его отказом канала. */
const told = ($: EngineInterface): void => {
  void context($).catch((failure: unknown) => {
    $.ui.log(`процент контекста не назван: ${reason(failure)}`, { to: 'debug' })
  })
}

/**
 * speakName называет службе запомненное название чата, если на этом входе оно ещё не названо.
 * Имя темы без аргумента служба берёт из него, а меняется оно — тема переименовывается.
 */
const speakName = ($: EngineInterface): Promise<void> => {
  if (front === undefined || chat === '' || chat === named) {
    return Promise.resolve()
  }

  named = chat

  return notice($, PATH_NAME, { name: chat })
}

/**
 * name запоминает название чата, которое назвал источник, и называет его службе. Событием модуля
 * оно не приходит вовсе, поэтому мод держит его сам и отдаёт, как только у соединения есть вход:
 * классический хук приходит раньше `session.start`, а вход поднимается им же.
 */
const name = ($: EngineInterface, source: Source, title: unknown): void => {
  if (typeof title !== 'string') {
    return
  }

  const value = title.trim()

  if (value === '' || value === heard[source]) {
    return
  }

  heard[source] = value
  $.ui.log(`${source === 'journal' ? 'журнал сессии' : 'вход хука'} назвал чат: ${value}`, {
    to: 'debug',
  })

  if (value === chat) {
    return
  }

  chat = value
  void speakName($)
}

/**
 * latest находит в журнале последнюю запись вида `type` и отдаёт её поле `field`. Ищется ключ поля
 * с конца текста, а разбирается только строка, где он стоит: журнал не раскладывается на записи
 * целиком. Ключ без кавычек-экранов внутри строки чужой записи не встречается — кавычка в значении
 * JSON экранируется, — а совпадение в записи другого вида отсеивает проверка `type`.
 */
const latest = (text: string, type: string, field: string): string | undefined => {
  const key = `"${field}":`
  let from = text.length

  while (from >= 0) {
    const found = text.lastIndexOf(key, from)

    if (found === -1) {
      return undefined
    }

    const start = text.lastIndexOf('\n', found) + 1
    const end = text.indexOf('\n', found)
    const line = text.slice(start, end === -1 ? undefined : end)

    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const value = row[field]

      if (row.type === type && typeof value === 'string' && value.trim() !== '') {
        return value
      }
    } catch {
      // Последняя строка журнала может быть недописанной, пока клиент её пишет: прежние записи
      // это не отменяет, и разбор идёт дальше к началу.
    }

    from = start - 2
  }

  return undefined
}

/**
 * read заглядывает в журнал сессии за названием чата: последнее `custom-title` (`/rename`, хуки,
 * `/away <имя>`), а без него — последнее `ai-title` (автоимя). Журнал, чьи размер и время правки
 * не сменились, второй раз не читается; `$.fs.read` отдаёт файл только целиком, поэтому сменивший
 * метку журнал читается весь, а больше 4 МиБ движок не читает вовсе — тогда названием остаётся
 * то, что назвал вход хука, а отказ уходит в журнал отладки.
 */
const read = async ($: EngineInterface): Promise<void> => {
  const path = journal

  if (path === undefined) {
    return
  }

  try {
    const stat = await $.fs.stat(path)
    const mark = `${stat.size}:${stat.mtimeMs}`

    if (mark === journalMark) {
      return
    }

    journalMark = mark

    const text = await $.fs.read(path)

    if (path !== journal) {
      return
    }

    name($, 'journal', latest(text, 'custom-title', 'customTitle') ?? latest(text, 'ai-title', 'aiTitle'))
  } catch (failure) {
    $.ui.log(`журнал сессии не прочитан: ${reason(failure)}`, { to: 'debug' })
  }
}

/** peek читает журнал, не начиная второго чтения рядом с идущим. */
const peek = ($: EngineInterface): Promise<void> => {
  peeking ??= read($).finally(() => {
    peeking = undefined
  })

  return peeking
}

/** heed берёт из входа классического хука журнал сессии и название чата, а журнал читает. */
const heed = ($: EngineInterface, event: { transcript_path?: unknown; session_title?: unknown }): void => {
  if (typeof event.transcript_path === 'string' && event.transcript_path !== journal) {
    journal = event.transcript_path
    journalMark = ''
    heard.journal = ''
  }

  name($, 'hook', event.session_title)
  void peek($)
}

/**
 * watch заводит опрос журнала таймером движка (`$.clock.every`): `/rename` модулю не сообщается
 * ничем, и новое имя видно только записью журнала. Перезагрузка мода снимает таймер вместе с
 * прежним окружением.
 */
const watch = ($: EngineInterface): void => {
  polling?.cancel()
  polling = $.clock.every(TITLE_POLL_MS, () => {
    void peek($)
  })
}

/**
 * Слово владельца: подача промпта с признаком «от пользователя» и провенансом первыми строками
 * текста. Обёртки клиента «написала другая сессия» на этом пути нет вовсе — модель читает текст
 * голым и называет отправителем владельца.
 */
const word = async ($: EngineInterface, event: Linked): Promise<void> => {
  const delivery = event.delivery_id ?? ''
  const text = event.text ?? ''
  const provenance = event.provenance ?? ''

  if (text === '' || provenance === '') {
    await confirm($, delivery, 'rejected', 'доставка без текста или без провенанса')

    return
  }

  try {
    const entered = await $.prompt.submit({ text: `${provenance}\n\n${text}`, asUser: true })

    if (entered.drop !== undefined) {
      await confirm($, delivery, 'rejected', `подача не прошла: ${entered.drop}`)

      return
    }

    remember(delivery)
    await confirm($, delivery, 'accepted', '')
  } catch (failure) {
    await confirm($, delivery, 'rejected', `подача не прошла: ${reason(failure)}`)
  }
}

/**
 * Команда из темы: вызов, равный набору команды владельцем в терминале. Вызов ждёт простоя, и
 * ждём его мы вне обработчика хода — иначе ожидание держало бы ход.
 */
const command = async ($: EngineInterface, event: Linked): Promise<void> => {
  const delivery = event.delivery_id ?? ''
  const { name, args } = head(event.text ?? '')

  if (name === '') {
    await confirm($, delivery, 'rejected', 'команда без имени')

    return
  }

  try {
    await $.command.run({ command: name, args })
    remember(delivery)
    await confirm($, delivery, 'accepted', '')
  } catch (failure) {
    await confirm($, delivery, 'rejected', `команда не исполнилась: ${reason(failure)}`)
  }
}

/** deliver разводит доставку по виду. Незнакомый вид в сессию не подаётся. */
const deliver = async ($: EngineInterface, event: Linked): Promise<void> => {
  const delivery = event.delivery_id ?? ''

  // Повтор уже принятой доставки — служба не услышала подтверждения: подаётся только подтверждение.
  if (delivery !== '' && accepted.has(delivery)) {
    $.ui.log(`доставка ${delivery} уже принята: подтверждаю без второй подачи`, { to: 'debug' })

    return await confirm($, delivery, 'accepted', '')
  }

  if (event.kind === 'owner-message') {
    return await word($, event)
  }

  if (event.kind === 'client-command') {
    return await command($, event)
  }

  await confirm($, event.delivery_id ?? '', 'rejected', `доставка незнакомого вида ${event.kind}`)
}

/**
 * fault говорит владельцу об отказе, после которого канала нет: расхождение версий контракта или
 * вытеснённое соединение сессии. Говорится это тем, чем мод вообще говорит в терминале, — подачи
 * служебной строки моста в сессию от имени владельца не бывает.
 */
const fault = ($: EngineInterface, event: Linked): void => {
  const text = event.text ?? 'служба отказала'

  refused = true

  if (front === undefined) {
    unlinked($, text)

    return
  }

  said($, text)
}

/**
 * gone говорит владельцу, что службы нет дольше штатного перезапуска: подкоманда звонит дальше
 * сама, а владелец знает, что слово из темы пока не дойдёт. Потеря связи короче (`lost`) идёт в
 * журнал отладки. Соединение, которое ещё ни разу не открылось, владельца не тревожит: причину
 * назовёт `/away`.
 */
const gone = ($: EngineInterface, event: Linked): void => {
  const text = event.text ?? 'службы нет, жду её'

  if (front === undefined) {
    unlinked($, text)

    return
  }

  if (!spoken) {
    said($, text)
  }
}

/** take разбирает одну строку выдачи подкоманды. */
const take = async ($: EngineInterface, line: string): Promise<void> => {
  let event: Linked

  try {
    event = JSON.parse(line) as Linked
  } catch (failure) {
    $.ui.log(`строка соединения не разобрана: ${reason(failure)}`, { to: 'debug' })

    return
  }

  switch (event.event) {
    case 'ready': {
      const door = opened(event)

      if (door === undefined) {
        $.ui.log('подкоманда открыла соединение, но входа не назвала: ни сокета, ни адреса с ключом', {
          to: 'debug',
        })

        return
      }

      front = door
      absent = undefined
      // Название, запомненное до входа, уходит службе сразу: иначе имя темы без аргумента пришлось
      // бы ждать следующего слова владельца, а его у не у компьютера может не быть вовсе.
      everOpened = true
      named = ''
      void speakName($)
      release($)
      $.ui.log(`соединение со службой открыто: ${where(door)}`, { to: 'debug' })

      return
    }
    case 'steady':
      // Сказанное о пропаже снимается, когда соединение прожило срок, а не на каждом `ready`:
      // служба, падающая сразу после приветствия, иначе сыпала бы тостами по кругу.
      return restored($)
    case 'undelivered':
      return warned($, event.text ?? 'реплика агента не дошла до темы')
    case 'delivery':
      return await deliver($, event)
    case 'error':
      return fault($, event)
    case 'absent':
      return gone($, event)
    default:
      $.ui.log(`событие соединения ${event.event}: ${event.text ?? ''}`, { to: 'debug' })
  }
}

/**
 * call зовёт подкоманду моста коротким вызовом и отдаёт её исход: код возврата, стандартную выдачу
 * и поток ошибок. Долгим он не бывает: `away on|off` живёт один запрос.
 */
const call = async (
  $: EngineInterface,
  argv: string[],
): Promise<{ code: number | null; out: string; err: string }> => {
  const child = $.process.spawn({ argv })

  let out = ''
  let err = ''

  for await (const piece of child) {
    if (piece.stream === 'stderr') {
      err += piece.text

      continue
    }

    out += piece.text
  }

  const ended = await child.result

  return { code: ended.code, out, err }
}

/**
 * switched зовёт `telegram-bridge away on|off --session <id>` и собирает строку исхода для
 * владельца. Задание модели этим не выдаётся: ответ хука `command.run` без `next` — вывод
 * команды, а не слово владельца, и хода модели команда не тратит.
 */
const switched = async (
  $: EngineInterface,
  which: 'on' | 'off',
  typed: string,
): Promise<{ text: string }> => {
  const path = (await $.env.get('DM_TELEGRAM_BRIDGE')) ?? BINARY
  const name = typed.trim()
  const argv = [path, 'away', which, ...(which === 'on' && name !== '' ? [name] : []), '--session']

  argv.push(await $.session.id())

  const failed = which === 'on' ? 'режим не включён' : 'режим не снят'

  // Без соединения служба включила бы режим, а слово из темы в сессию не дошло бы.
  if (which === 'on' && absent !== undefined) {
    return { text: `${failed}: ${absent}` }
  }

  if (which === 'on') {
    // Чат могли переименовать без промпта (`/rename`): журнал читается до включения, и тема без
    // аргумента берёт свежее имя, а не то, что было на последнем слове владельца.
    await peek($)

    // Имя из аргумента — название чата: тема получает его сразу, сам чат — ближайшим промптом.
    if (name !== '') {
      chat = name
      retitle = name
      $.ui.log(`название чата из /away: ${name}`, { to: 'debug' })
    }

    await speakName($)
  }

  try {
    const ended = await call($, argv)

    if (ended.code === 0) {
      const said = ended.out.trim()

      return {
        text: said === '' ? (which === 'on' ? 'режим включён' : 'режим снят') : said,
      }
    }

    const why = ended.err.trim()

    return {
      text: `${failed}: ${why === '' ? `away ${which} кончился кодом ${String(ended.code)}` : why}`,
    }
  } catch (failure) {
    return { text: `${failed}: ${reason(failure)}` }
  }
}

/**
 * registered заводит команды режима у клиента. Задание модели у команды своё не появляется:
 * регистрация только называет её клиенту, а исполняет её хук `command.run` этого же модуля.
 * `immediate` — команда срабатывает и посреди хода модели: режим включают и тогда, когда агент
 * работает.
 */
const registered = async ($: EngineInterface): Promise<void> => {
  const wanted = [
    {
      name: COMMAND_AWAY,
      description: 'Telegram: режим «не у компьютера» — реплики и вопросы сессии идут в тему',
      argumentHint: '[имя темы]',
    },
    {
      name: COMMAND_HERE,
      description: 'Telegram: снять режим «не у компьютера» — вопросы снова в терминале',
      argumentHint: '',
    },
  ]

  for (const one of wanted) {
    try {
      await $.command.register({
        name: one.name,
        description: one.description,
        ...(one.argumentHint === '' ? {} : { argumentHint: one.argumentHint }),
        immediate: true,
      })
    } catch (failure) {
      // Команда, которой не нашлось места, — не тишина: владелец наберёт `/away` и не поймёт,
      // почему её нет. Строка идёт в расшифровку сессии и в журнал отладки, но не модели.
      $.ui.log(`команда /${one.name} не зарегистрирована: ${reason(failure)}`, {
        to: 'transcript',
      })
    }
  }
}

/**
 * hold держит подкоманду, пока жива сессия: её цикл и есть жизнь дочернего процесса, поэтому
 * конец цикла гасит соединение. Строки читаются по одной — пустых строк в выдаче нет. Отвечает,
 * надо ли поднять подкоманду заново.
 */
const hold = async ($: EngineInterface, session: string): Promise<boolean> => {
  const path = (await $.env.get('DM_TELEGRAM_BRIDGE')) ?? BINARY
  const child = $.process.spawn({ argv: [path, 'link', '--session', session] })

  refused = false
  alive = true

  try {
    return await held($, child)
  } finally {
    alive = false
  }
}

/** held читает выдачу подкоманды до её конца и решает, поднимать ли её заново. */
const held = async (
  $: EngineInterface,
  child: ReturnType<EngineInterface['process']['spawn']>,
): Promise<boolean> => {
  let rest = ''
  let complaint = ''

  for await (const piece of child) {
    if (piece.stream === 'stderr') {
      complaint = piece.text.trim()
      $.ui.log(piece.text.trimEnd(), { to: 'debug' })

      continue
    }

    rest += piece.text

    const lines = rest.split('\n')
    rest = lines.pop() ?? ''

    for (const line of lines) {
      if (line.trim() !== '') {
        await take($, line)
      }
    }
  }

  const ended = await child.result
  const how = ended.signal === null ? `код ${ended.code}` : `сигнал ${ended.signal}`

  const wasOpen = front !== undefined

  // Сокета подкоманды больше нет: сказать в него нечего, и `session.end` после этого `bye` не шлёт.
  front = undefined

  $.ui.log(`соединение со службой кончилось: ${how}`, { to: 'debug' })

  // Кодом 0 подкоманда кончается только штатно: по `bye` мода или по остановке клиентом, на которой
  // она говорит `bye` сама, — клиент гасит её на выходе раньше, чем зовёт `session.end`. Потеря
  // связи со службой её не кончает: подкоманда звонит снова сама, в том же процессе. Отказ службы
  // кончает её насовсем, и о нём владельцу уже сказано событием `error`.
  if (ended.code === 0 && ended.signal === null) {
    return false
  }

  const line = `канала нет, соединение кончилось (${how})`

  // Соединение, которое так и не открылось, — не пропажа, а мост, который не настроен: нет
  // настроек, служба отказала. Причину назовёт `/away`, а новый запуск того же не исправит.
  if (!wasOpen) {
    const why = complaint === '' ? line : complaint

    // Подъём после сказанного «поднимаю заново» не открыл соединения: обещание не сбылось, и
    // владелец узнаёт об этом, а не ждёт канала, которого не будет.
    if (revival) {
      revival = false
      spoken = false
      said($, `канал не поднялся: ${why}`)
    }

    unlinked($, why)

    return false
  }

  revival = false

  absent = line

  if (refused) {
    return false
  }

  // Канал был и пропал вместе с процессом: его убили или он упал. Молчать об этом нельзя — в теме
  // владелец увидит только отметку придержанного на своём сообщении, — и подкоманда поднимается
  // заново, а вернувшийся канал снимет сказанное.
  if (!spoken) {
    said($, `${line}; поднимаю заново`)
  }

  revival = true

  return true
}

/** farewell говорит службе, что сессия кончилась: хоронит её служба сама. */
const farewell = async ($: EngineInterface): Promise<void> => {
  const door = front

  // Соединения нет: не поднялось или уже кончилось — на выходе клиента подкоманда сказала `bye`
  // сама, на остановке.
  if (door === undefined) {
    $.ui.log('конец сессии мод не говорит: соединения со службой нет', { to: 'debug' })

    return
  }

  try {
    await post($, door, PATH_BYE, {})
  } catch (failure) {
    $.ui.log(`конец сессии службе не сказан: ${reason(failure)}`, { to: 'debug' })
  }
}

/**
 * attach поднимает соединение сессии, не держа ход: ход кончается, а соединение остаётся.
 * Подкоманда, у которой канал был и пропал вместе с процессом, поднимается снова после паузы.
 * Пауза идёт таймером модуля: перезагрузка мода снимает его вместе с прежним окружением, и прежний
 * модуль второго держателя сессии рядом с новым не поднимет.
 */
const attach = ($: EngineInterface, session: string): void => {
  forget()

  if (alive) {
    $.ui.log('подкоманда моста уже идёт: второй держатель сессии не поднимается', { to: 'debug' })

    return
  }

  linkedSession = session

  holding = hold($, session).then(
    (respawn: boolean) => {
      if (respawn) {
        respawning = $.clock.after(RESPAWN_PAUSE_MS, () => {
          respawning = undefined
          attach($, session)
        })
      } else {
        lose($)
      }
    },
    (failure: unknown) => {
      const why = `соединение со службой не поднялось: ${reason(failure)}`

      if (revival) {
        revival = false
        spoken = false
        said($, `канал не поднялся: ${why}`)
      }

      lose($)
      unlinked($, why)
    },
  )
}

/**
 * rebind перепривязывает подкоманду к другой сессии того же процесса: `/resume` внутри клиента
 * кончает прежнюю сессию (`session.end` с `resume`) и продолжает процесс под другим id, а нового
 * `session.start` модулю не бывает. Прежней службе говорится `bye`, и новая подкоманда держит уже
 * новую сессию.
 */
const rebind = async ($: EngineInterface, session: string): Promise<void> => {
  if (linkedSession === undefined || linkedSession === session) {
    return
  }

  forget()

  if (alive) {
    await farewell($)
  }

  await holding

  $.ui.log(`подкоманда моста перепривязана к сессии ${session}`, { to: 'debug' })
  attach($, session)

  // Конец прежней сессии мог прийти раньше и снять опрос: у продолженной сессии он свой.
  watch($)
}

/** forget снимает отложенный подъём подкоманды. */
const forget = (): void => {
  respawning?.cancel()
  respawning = undefined
}

/** lose говорит о репликах, которые ждали подкоманду, а она так и не поднялась. */
const lose = ($: EngineInterface): void => {
  const count = waiting.splice(0).length

  // Мост, который ни разу не открыл соединения, не настроен: владелец о нём не тревожится, причину
  // назовёт `/away`.
  if (count > 0 && !everOpened) {
    $.ui.log(`реплик агента не доставлено: ${count} — соединения со службой не было`, { to: 'debug' })

    return
  }

  if (count > 0) {
    warned($, `реплик агента не доставлено в тему: ${count} — подкоманда моста не поднялась`)
  }
}

export const register: Register = on => {
  // Название чата событием модуля не приходит вовсе: у `session.start` его нет, а о `/rename`
  // движок модулю не сообщает. Поэтому мод берёт его из двух мест — из входа классического хука
  // (`session_title`, на старте, возврате и слове владельца) и из журнала сессии, путь к которому
  // несёт тот же вход: журнал читается на этих хуках, на границах хода, перед `/away` и опросом.
  on('classic.SessionStart', async ($, event, next) => {
    heed($, event)

    // `/resume` внутри процесса: клиент продолжает работу под другой сессией, а `session.start`
    // модулю не повторяет. Подкоманда переезжает на новую сессию сама.
    if (event.source === 'resume' && typeof event.session_id === 'string') {
      await rebind($, event.session_id)
    }

    return next(event)
  })

  // Имя из `/away <имя>` чат получает здесь: ответ этого хука — единственное место, где модуль
  // называет клиенту название чата (`sessionTitle`). Отдаётся оно один раз — дальше название
  // чата снова ведёт сам клиент.
  on('classic.UserPromptSubmit', async ($, event, next) => {
    heed($, event)

    const answered = await next(event)
    const wanted = retitle

    if (wanted === undefined) {
      return answered
    }

    retitle = undefined

    return { ...answered, sessionTitle: wanted }
  })

  on('session.start', async ($, event, next) => {
    const started = await next(event)

    await registered($)
    attach($, await $.session.id())
    watch($)

    return started
  })

  // Команды режима обслуживает сам мод: ответ без `next` — вывод команды, а не задание модели.
  // Поэтому `/away` и `/here` не будят модель и не тратят хода, а `immediate` при регистрации
  // делает их слышными и посреди идущего хода. Слово владельца эти команды не подают: они зовут
  // короткий вызов службы, как и раньше звали файлы `commands/`.
  on('command.run', { command: COMMAND_AWAY }, async ($, event) =>
    switched($, 'on', event.args ?? ''),
  )

  on('command.run', { command: COMMAND_HERE }, async ($, event) => switched($, 'off', ''))

  on('turn.start', async ($, event, next) => {
    // Ход подагента ходом сессии не считается: в теме владелец видит работу самой сессии, а
    // субагенты идут внутри её хода и своих границ в тему не приносят.
    if (event.agentId === undefined) {
      // Ход назван своим id: извещения ответа не ждут, и по нему служба гасит «печатает» только
      // того хода, чей конец пришёл, — поздний конец прошлого не гасит следующий.
      void notice($, PATH_TURN_START, { turn: event.turnId })

      // Между ходами окно контекста меняется само — сжатие, `/clear`, — поэтому процент
      // называется и на входе в ход, а не только на выходе из него.
      told($)
      void peek($)
    }

    return next(event)
  })

  // Поток реплик: в тему уходит дописанная реплика агента целиком, одним сообщением. Кусков на
  // лету служба не принимает вовсе — пока реплика пишется, владелец видит в теме «печатает».
  //
  // Дописанность называет сам клиент, а не разбор текста: шаг хода идёт модулю хуков потоком
  // кусков своего вида (`text`, `thinking`, `tool`, `input`, `stop`, `engine`), а его итог несёт
  // `answer` — видимый текст ответа модели, собранный клиентом, когда все блоки ответа пришли, — и
  // `stopReason`, которым клиент называет, чем ответ кончился. Поэтому мод куски пропускает как
  // есть и берёт один `answer`: вывод инструментов, его вход и мысли в тему не попадают по
  // устройству события, а не по угадыванию. Конца отдельного блока текста клиент не называет ничем
  // — границы блоков идут в непрозрачных куску вида `engine`, — поэтому концом реплики считается
  // конец шага, и это единственная дописанность, которую клиент объявляет сам.
  on('turn.step', async function* ($, event, next) {
    const answered = yield* next(event)

    // Шаг подагента в тему не идёт: в теме владелец видит работу самой сессии, а субагенты идут
    // внутри её хода — их реплики в терминале он тоже видит не как речь сессии.
    if (event.agentId === undefined) {
      reply($, answered)
    }

    return answered
  })

  on('turn.complete', async ($, event, next) => {
    const answered = await next(event)

    if (event.agentId === undefined) {
      void notice($, PATH_TURN_END, { turn: event.turnId })
      told($)
      void peek($)
    }

    return answered
  })

  on('session.end', async ($, event, next) => {
    // `/clear` кончает разговор, но не процесс: нового `session.start` для сессии, которая
    // встала на его место, клиент не поднимает. Скажи мы тут `bye`, соединение закрылось бы
    // насовсем, и слово владельца перестало бы доходить до конца работы клиента. Поэтому на
    // `clear` соединение остаётся, и служба знает сессию под прежним id; сверки id с текущим мод
    // пока не делает.
    //
    // Конец сессии, которую подкоманда уже не держит (перепривязка на `/resume` успела раньше),
    // `bye` не говорит: он похоронил бы новую сессию.
    if (event.reason !== 'clear' && (linkedSession === undefined || event.sessionId === linkedSession)) {
      forget()
      polling?.cancel()
      polling = undefined
      await farewell($)
    }

    return next(event)
  })
}
