import type { EngineInterface, Register } from 'claude-code'

/**
 * Мод моста Telegram: держит соединение сессии со службой, подаёт слово владельца в сессию новым
 * ходом, исполняет команду из темы и называет службе границы хода и долю занятого окна контекста.
 *
 * Сокетов у модуля хуков нет вовсе, поэтому соединение сессии держит подкоманда
 * `telegram-bridge link`: доставку она отдаёт строкой JSON своей стандартной выдачи, а короткий
 * запрос принимает на свой сокет, адрес которого называет событием `ready`. Протокол и роли —
 * контракт службы `telegram-bridge`; служба в этом репозитории не публикуется.
 */

/** Адрес местного входа подкоманды: имя хоста здесь роли не играет, запрос идёт в сокет. */
const FRONT = 'http://telegram-bridge'

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
 * Адрес местного входа подкоманды, как она назвала его событием `ready`. Своё у каждого запуска
 * модуля: перезапуск мода поднимает своё соединение и свой вход.
 */
let front: string | undefined

/** Владельцу о пропавшем канале уже сказано: второй раз одно и то же не говорится. */
let spoken = false

/**
 * Название чата, как его последним назвал клиент, и то, какое из названий уже ушло службе на этом
 * соединении. Служба держит название у себя: имя темы без аргумента берётся из него, а пока оно
 * меняется — тема переименовывается.
 */
let chat = ''
let named = ''

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

/** head отрезает у строки команды имя: всё после первого пробела — её аргументы. */
const head = (line: string): { name: string; args: string } => {
  const body = line.trim().replace(/^\/+/, '')
  const gap = body.search(/\s/)

  return gap === -1
    ? { name: body, args: '' }
    : { name: body.slice(0, gap), args: body.slice(gap + 1).trim() }
}

/**
 * post зовёт местный вход подкоманды по адресу, который она назвала сама. Адрес — довод звонящего:
 * входа может не быть вовсе, и решает это тот, кто знает, что делать без него.
 */
const post = async (
  $: EngineInterface,
  socket: string,
  path: string,
  body: unknown,
): Promise<Answered> => {
  const answered = await $.http.fetch(`${FRONT}${path}`, {
    method: 'POST',
    socketPath: socket,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  return { ok: answered.ok, status: answered.status, text: answered.text }
}

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
  const socket = front

  if (socket === undefined) {
    said($, `приём ${delivery} подтверждать некуда: соединение не назвало свой вход`)

    return
  }

  // Отказ подтверждения — рабочее состояние протокола, а не исключение: рвать им единственный
  // цикл чтения доставок нельзя, иначе клиент погасит дочерний процесс вместе с каналом.
  try {
    const answered = await post($, socket, PATH_ACK, { delivery_id: delivery, outcome, detail })

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
 * отладки — канала может не быть вовсе, и ронять им ход нельзя.
 */
const notice = ($: EngineInterface, path: string, body: unknown): void => {
  const socket = front

  if (socket === undefined) {
    return
  }

  void post($, socket, path, body)
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

  notice($, PATH_CONTEXT, { percent: share })
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

  notice($, PATH_MESSAGE, { text })
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
const speakName = ($: EngineInterface): void => {
  if (front === undefined || chat === '' || chat === named) {
    return
  }

  named = chat
  notice($, PATH_NAME, { name: chat })
}

/**
 * name запоминает название чата и называет его службе. Приходит оно не событием модуля, а входом
 * хука клиента (`session_title`), поэтому мод держит его сам и отдаёт, как только у соединения
 * есть вход: классический хук приходит раньше `session.start`, а вход поднимается им же.
 */
const name = ($: EngineInterface, title: unknown): void => {
  if (typeof title !== 'string') {
    return
  }

  const value = title.trim()

  if (value === '' || value === chat) {
    return
  }

  chat = value
  speakName($)
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
    await confirm($, delivery, 'accepted', '')
  } catch (failure) {
    await confirm($, delivery, 'rejected', `команда не исполнилась: ${reason(failure)}`)
  }
}

/** deliver разводит доставку по виду. Незнакомый вид в сессию не подаётся. */
const deliver = async ($: EngineInterface, event: Linked): Promise<void> => {
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
  said($, event.text ?? 'служба отказала')
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
    case 'ready':
      front = event.socket
      // Название, запомненное до входа, уходит службе сразу: иначе имя темы без аргумента пришлось
      // бы ждать следующего слова владельца, а его у не у компьютера может не быть вовсе.
      named = ''
      speakName($)
      $.ui.log(`соединение со службой открыто: ${event.socket}`, { to: 'debug' })

      return
    case 'delivery':
      return await deliver($, event)
    case 'error':
      return fault($, event)
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
 * конец цикла гасит соединение. Строки читаются по одной — пустых строк в выдаче нет.
 */
const hold = async ($: EngineInterface, session: string): Promise<void> => {
  const path = (await $.env.get('DM_TELEGRAM_BRIDGE')) ?? BINARY
  const child = $.process.spawn({ argv: [path, 'link', '--session', session] })

  let rest = ''

  for await (const piece of child) {
    if (piece.stream === 'stderr') {
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

  // Сокета подкоманды больше нет: сказать в него нечего, и `session.end` после этого `bye` не шлёт.
  front = undefined

  $.ui.log(`соединение со службой кончилось: ${how}`, { to: 'debug' })

  // Кодом 0 подкоманда кончается только штатно: по `bye` мода или по остановке клиентом, на которой
  // она говорит `bye` сама, — клиент гасит её на выходе раньше, чем зовёт `session.end`. Любой
  // другой конец значит, что канала больше нет: настройки не названы, служба отказала, процесс убит.
  // Молчать об этом нельзя — в теме владелец увидит только отметку придержанного на своём
  // сообщении, а причина здесь. Об отказе службы ему уже сказано событием `error`.
  const finished = ended.code === 0 && ended.signal === null

  if (!finished && !spoken) {
    said($, `канала нет, соединение кончилось (${how})`)
  }
}

/** farewell говорит службе, что сессия кончилась: хоронит её служба сама. */
const farewell = async ($: EngineInterface): Promise<void> => {
  const socket = front

  // Соединения нет: не поднялось или уже кончилось — на выходе клиента подкоманда сказала `bye`
  // сама, на остановке.
  if (socket === undefined) {
    $.ui.log('конец сессии мод не говорит: соединения со службой нет', { to: 'debug' })

    return
  }

  try {
    await post($, socket, PATH_BYE, {})
  } catch (failure) {
    $.ui.log(`конец сессии службе не сказан: ${reason(failure)}`, { to: 'debug' })
  }
}

/** attach поднимает соединение сессии, не держа ход: ход кончается, а соединение остаётся. */
const attach = ($: EngineInterface, session: string): void => {
  void hold($, session).catch((failure: unknown) => {
    said($, `соединение со службой не поднялось: ${reason(failure)}`)
  })
}

export const register: Register = on => {
  // Название чата клиент называет входом классического хука, а не событием модуля: у
  // `session.start` его нет. Первое название приходит на старте и возврате сессии, дальше — со
  // словом владельца, набранным в терминале, и переименование чата видно на следующем.
  on('classic.SessionStart', ($, event, next) => {
    name($, event.session_title)

    return next(event)
  })

  on('classic.UserPromptSubmit', ($, event, next) => {
    name($, event.session_title)

    return next(event)
  })

  on('session.start', async ($, event, next) => {
    const started = await next(event)

    await registered($)
    attach($, await $.session.id())

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
      notice($, PATH_TURN_START, { turn: event.turnId })

      // Между ходами окно контекста меняется само — сжатие, `/clear`, — поэтому процент
      // называется и на входе в ход, а не только на выходе из него.
      told($)
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
      notice($, PATH_TURN_END, { turn: event.turnId })
      told($)
    }

    return answered
  })

  on('session.end', async ($, event, next) => {
    // `/clear` кончает разговор, но не процесс: нового `session.start` для сессии, которая
    // встала на его место, клиент не поднимает. Скажи мы тут `bye`, соединение закрылось бы
    // насовсем, и слово владельца перестало бы доходить до конца работы клиента. Поэтому на
    // `clear` соединение остаётся, и служба знает сессию под прежним id; сверки id с текущим мод
    // пока не делает.
    if (event.reason !== 'clear') {
      await farewell($)
    }

    return next(event)
  })
}
