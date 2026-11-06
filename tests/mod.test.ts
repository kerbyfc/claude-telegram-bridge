import type { HttpInit, On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

/** Сокет местного входа, который подкоманда называет событием готовности. */
const SOCKET = '/tmp/dmtg-test/l.sock'

/** Провенанс доставки: готовая строка, которую мод приклеивает к подаче. */
const PROVENANCE = 'Доставлено из Telegram, автор Александр, человек'

/** steady — соединение прожило срок: связь вернулась всерьёз. */
const steady = JSON.stringify({ event: 'steady' })

/** ready — событие открытого соединения сессии. */
const ready = JSON.stringify({ event: 'ready', socket: SOCKET, mode: 'on', topic_name: 'tg-inventory' })

/** word — доставка со словом владельца. */
const word = JSON.stringify({
  event: 'delivery',
  kind: 'owner-message',
  delivery_id: 'd-1',
  text: 'посмотри на диффе',
  provenance: PROVENANCE,
})

/** command — доставка с командой из темы. */
const command = JSON.stringify({
  event: 'delivery',
  kind: 'client-command',
  delivery_id: 'd-2',
  text: '/compact покороче',
  provenance: PROVENANCE,
})

/** acked — тело подтверждения приёма, как его посылает мод. */
type acked = { delivery_id?: string; outcome?: string; detail?: string }

/**
 * bottom отвечает за движок под плагинами: границы сессии кит сам не держит. `ended` зовётся под
 * модом на конце сессии — так тест гасит подкоманду, которую держит живой до `session.end`.
 */
const bottom = (on: On, logged?: (text: string) => void, ended?: () => void): void => {
  on('session.start', (_$, event) => ({ cwd: event.cwd }))
  on('session.end', (_$, event) => {
    ended?.()

    return { sessionId: event.sessionId }
  })
  on('session.id', () => ({ value: 's-1' }))
  on('turn.start', (_$, event) => ({ turnId: event.turnId }))
  on('turn.complete', (_$, event) => ({ text: event.answer }))
  on('ui.log', (_$, event) => {
    logged?.(event.text)

    return { value: undefined }
  })
}

/** sent разбирает тело короткого запроса мода на местный вход. */
const sent = (init: HttpInit | undefined): acked => JSON.parse(init?.body ?? '{}') as acked

/** called — один короткий запрос мода на местный вход: путь и разобранное тело. */
type called = { url: string; body: Record<string, unknown> }

/** body разбирает тело короткого запроса мода. */
const body = (init: HttpInit | undefined): Record<string, unknown> =>
  JSON.parse(init?.body ?? '{}') as Record<string, unknown>

/**
 * stepping — движок под модом на шаге хода: шаг идёт потоком кусков своего вида — мысли, текст
 * реплики по частям, вызов инструмента и его вход, — а итогом несёт дописанный ответ. Так шаг
 * выглядит и у настоящего клиента, поэтому тест различает куски видом, а не разбором текста.
 */
const stepping = (on: On, answer: string): void => {
  on('turn.step', async function* (_$, event) {
    yield { kind: 'thinking' as const, index: 0, text: 'взвешиваю' }
    yield { kind: 'text' as const, index: 1, text: 'чита' }
    yield { kind: 'text' as const, index: 1, text: 'ю диффы' }
    yield { kind: 'tool' as const, index: 2, id: 'tu-1', name: 'Read' }
    yield { kind: 'input' as const, index: 2, json: '{"file_path":"a.go"}' }
    yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null }

    return {
      turnId: event.turnId,
      index: event.index,
      answer,
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: null,
    }
  })
}

/**
 * linked — соединение сессии, открытое и больше ничего не отдающее: тест ждёт только его.
 * Подкоманда живёт до конца сессии, как живёт настоящая: сокет её входа открыт, пока она идёт, и
 * кончается она кодом 0 — по `bye` мода, который тот шлёт на `session.end`.
 */
const linked = (on: On, opened: () => void): void => {
  let halt: (() => void) | undefined
  const halted = new Promise<void>(resolve => {
    halt = resolve
  })

  bottom(
    on,
    text => {
      if (text.startsWith('соединение со службой открыто')) {
        opened()
      }
    },
    () => halt?.(),
  )

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n` }

    await halted

    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
}

test('слово владельца подаётся от пользователя, приём подтверждается после подачи', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const steps: string[] = []
  const acks: acked[] = []
  const sockets: (string | undefined)[] = []

  let confirmed: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    confirmed = resolve
  })


  on('process.spawn', async function* (_$, event) {
    steps.push(`link ${event.argv.join(' ')}`)
    yield { stream: 'stdout' as const, text: `${ready}\n${word}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('prompt.submit', (_$, event) => {
    steps.push('submit')
    expect(event.text).toBe(`${PROVENANCE}\n\nпосмотри на диффе`)
    expect(event.origin).toEqual(expect.objectContaining({ kind: 'plugin', asUser: true }))

    return { text: event.text }
  })

  on('http.fetch', (_$, event) => {
    steps.push(`fetch ${event.url}`)
    acks.push(sent(event.init))
    sockets.push(event.init?.socketPath)
    confirmed?.()

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  expect(steps).toEqual([
    'link telegram-bridge link --session s-1',
    'submit',
    'fetch http://telegram-bridge/ack',
  ])
  expect(acks[0]).toEqual({ delivery_id: 'd-1', outcome: 'accepted', detail: '' })
  expect(sockets[0]).toBe(SOCKET)
})

test('подача не прошла — приём не подтверждается, слово остаётся придержанным', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const acks: acked[] = []

  let confirmed: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    confirmed = resolve
  })


  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n${word}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('prompt.submit', () => ({ drop: 'ход прерван' }))

  on('http.fetch', (_$, event) => {
    acks.push(sent(event.init))
    confirmed?.()

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  expect(acks[0]?.outcome).toBe('rejected')
  expect(acks[0]?.detail).toBe('подача не прошла: ход прерван')
})

test('команда из темы исполняется как набранная владельцем', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const ran: { command: string; args: string }[] = []
  const acks: acked[] = []

  let confirmed: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    confirmed = resolve
  })


  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n${command}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('command.run', (_$, event) => {
    ran.push({ command: event.command, args: event.args })

    return { text: 'контекст сжат' }
  })

  on('http.fetch', (_$, event) => {
    acks.push(sent(event.init))
    confirmed?.()

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  expect(ran).toEqual([{ command: 'compact', args: 'покороче' }])
  expect(acks[0]).toEqual({ delivery_id: 'd-2', outcome: 'accepted', detail: '' })
})

test('доставка незнакомого вида в сессию не подаётся', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const submits: string[] = []
  const acks: acked[] = []

  let confirmed: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    confirmed = resolve
  })

  const strange = JSON.stringify({ event: 'delivery', kind: 'owner-sticker', delivery_id: 'd-3' })


  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n${strange}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('prompt.submit', (_$, event) => {
    submits.push(event.text)

    return { text: event.text }
  })

  on('http.fetch', (_$, event) => {
    acks.push(sent(event.init))
    confirmed?.()

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  expect(submits).toEqual([])
  expect(acks[0]?.outcome).toBe('rejected')
  expect(acks[0]?.detail).toBe('доставка незнакомого вида owner-sticker')
})

test('отказ входа не гасит канал и слышен владельцу, а не журналу отладки', async ($, on) => {
  mock.env(on, {})

  const toasts: string[] = []
  const submits: string[] = []

  let twice: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    twice = resolve
  })

  bottom(on)

  const second = JSON.stringify({
    event: 'delivery',
    kind: 'owner-message',
    delivery_id: 'd-2',
    text: 'и ещё посмотри',
    provenance: PROVENANCE,
  })

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n${word}\n` }
    yield { stream: 'stdout' as const, text: `${second}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('prompt.submit', (_$, event) => {
    submits.push(event.text)

    if (submits.length === 2) {
      twice?.()
    }

    return { text: event.text }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })

  on('ui.status', () => ({ value: undefined }))

  // Вход подкоманды закрылся: подтверждение приёма не доходит.
  on('http.fetch', () => ({ deny: 'вход подкоманды закрылся' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  // Цикл чтения доставок жив: второе слово владельца тоже подано.
  expect(submits.length).toBe(2)
  expect(toasts[0]).toEqual(
    expect.stringContaining('мост Telegram: приём d-1 не дошёл, канала нет'),
  )
})

test('конец сессии мост слышит своим входом', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual(['http://telegram-bridge/bye'])
})

test('`/clear` соединения не закрывает: нового старта сессии клиент не поднимет', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting
  await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual([])
})

test('выход клиента: подкоманда погашена раньше `session.end`, и ни тоста, ни `bye` в мёртвый сокет', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []
  const toasts: string[] = []
  const logged: string[] = []

  let gone: (() => void) | undefined
  const ended = new Promise<void>(resolve => {
    gone = resolve
  })

  bottom(on, text => {
    logged.push(text)

    if (text.startsWith('соединение со службой кончилось')) {
      gone?.()
    }
  })

  // Так кончается подкоманда на выходе клиента: он гасит её сигналом, она говорит `bye` службе
  // сама и выходит кодом 0, а `session.end` приходит уже потом.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n` }

    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await ended
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(toasts).toEqual([])
  expect(paths).toEqual([])
  expect(logged).toContain('конец сессии мод не говорит: соединения со службой нет')
})

test('подкоманда умерла не по `bye` — владелец слышит, что канала нет, и она поднимается снова', async ($, on) => {
  mock.env(on, {})

  const clock = mock.clock(on)
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const spawned: string[] = []

  bottom(on)

  // Первый запуск умирает с кодом 1 — так кончается убитый или упавший процесс; второй открывает
  // соединение и живёт.
  on('process.spawn', async function* (_$, event) {
    spawned.push(event.argv.join(' '))

    if (spawned.length === 1) {
      yield { stream: 'stdout' as const, text: `${ready}\n` }

      return { value: { code: 1, signal: null } }
    }

    yield { stream: 'stdout' as const, text: `${ready}\n${steady}\n` }

    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })
  on('ui.status', (_$, event) => {
    statuses.push(event.text)

    return { value: undefined }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(toasts).toEqual(['мост Telegram: канала нет, соединение кончилось (код 1); поднимаю заново'])
  expect(spawned.length).toBe(1)

  // До паузы новый запуск не идёт: бинарь, которого нет, не крутился бы вхолостую.
  await clock.advance(4999)
  expect(spawned.length).toBe(1)

  await clock.advance(1)

  expect(spawned).toEqual([
    'telegram-bridge link --session s-1',
    'telegram-bridge link --session s-1',
  ])
  expect(toasts).toEqual([
    'мост Telegram: канала нет, соединение кончилось (код 1); поднимаю заново',
    'мост Telegram: канал вернулся',
  ])
  expect(statuses.at(-1)).toBeUndefined()
})

test('отказ службы событием `error` подкоманду заново не поднимает: второй держатель отбирал бы сессию', async ($, on) => {
  mock.env(on, {})

  const clock = mock.clock(on)
  const toasts: string[] = []
  let spawned = 0

  bottom(on)

  const fault = JSON.stringify({
    event: 'error',
    code: 'bad-request',
    text: 'соединение больше не держит сессию',
  })

  on('process.spawn', async function* () {
    spawned += 1

    yield { stream: 'stdout' as const, text: `${ready}\n${fault}\n` }

    return { value: { code: 1, signal: null } }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(60_000)

  expect(spawned).toBe(1)
  expect(toasts).toEqual(['мост Telegram: соединение больше не держит сессию'])
})

/** Test — `$`, каким его держит тело теста. */
type Test = Parameters<TestBody>[0]

/**
 * streamed — подкоманда одна на всё время: потерю связи со службой она переживает сама и говорит о
 * ней событиями, а сама не кончается. Отвечает тостами, которые за это время услышал владелец.
 */
const streamed = async ($: Test, on: On, lines: string[]): Promise<string[]> => {
  mock.env(on, {})

  const clock = mock.clock(on)
  const toasts: string[] = []

  bottom(on)

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: lines.map(line => `${line}\n`).join('') }

    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  return toasts
}

/** lost — подкоманда потеряла связь со службой и звонит снова. */
const lost = JSON.stringify({ event: 'lost', text: 'соединение со службой потеряно' })

/** absent — службы нет дольше штатного перезапуска. */
const absent = JSON.stringify({ event: 'absent', text: 'службы нет 30 с, жду её и подключусь сам' })

test('штатный перезапуск службы проходит молча: потеря связи и возврат владельцу не говорятся', async ($, on) => {
  expect(await streamed($, on, [ready, lost, ready])).toEqual([])
})

test('долгая пропажа службы слышна владельцу, а возврат снимает сказанное', async ($, on) => {
  expect(await streamed($, on, [ready, lost, absent, ready, steady])).toEqual([
    'мост Telegram: службы нет 30 с, жду её и подключусь сам',
    'мост Telegram: канал вернулся',
  ])
})

test('границы хода и процент контекста уходят службе одним путём', async ($, on) => {
  mock.env(on, {})

  const calls: { url: string; body: Record<string, unknown> }[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  let enough: (() => void) | undefined
  const told = new Promise<void>(resolve => {
    enough = resolve
  })

  linked(on, () => opened?.())

  // Процент мод берёт у клиента готовым: своего счёта контекста у него нет вовсе.
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 74_000, window: 200_000, percent: 37 },
      rateLimits: [],
    },
  }))

  on('http.fetch', (_$, event) => {
    calls.push({
      url: event.url,
      body: JSON.parse(event.init?.body ?? '{}') as Record<string, unknown>,
    })

    if (calls.length === 4) {
      enough?.()
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  await $.turn.start({ text: 'посмотри на диффе', turnId: 't-1' })
  await $.turn.complete({
    answer: 'посмотрел',
    durationMs: 5,
    isAborted: false,
    turnId: 't-1',
    reason: 'answer',
  })
  await told

  const urls = calls.map(one => one.url)

  expect(urls.includes('http://telegram-bridge/turn/start')).toBe(true)
  expect(urls.includes('http://telegram-bridge/turn/end')).toBe(true)

  // Ход назван своим id на обеих границах: по нему служба гасит «печатает» только своего хода.
  expect(calls.find(one => one.url === 'http://telegram-bridge/turn/start')?.body).toEqual({
    turn: 't-1',
  })
  expect(calls.find(one => one.url === 'http://telegram-bridge/turn/end')?.body).toEqual({
    turn: 't-1',
  })
  expect(urls.filter(one => one === 'http://telegram-bridge/context').length).toBe(2)
  expect(calls.find(one => one.url === 'http://telegram-bridge/context')?.body).toEqual({
    percent: 37,
  })
})

test('ход подагента границей хода сессии не считается', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 37 }, rateLimits: [] },
  }))

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  await $.turn.start({ text: '', turnId: 't-2', agentId: 'a-1' })
  await $.turn.complete({
    answer: 'отчёт',
    durationMs: 5,
    isAborted: false,
    turnId: 't-2',
    reason: 'answer',
    agentId: 'a-1',
  })

  // Конец сессии — вызов, которого мод дожидается: всё, что он успел послать до него, уже здесь.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual(['http://telegram-bridge/bye'])
})

test('в тему уходит дописанная реплика целиком: ни кусков, ни мыслей, ни вызова инструмента', async ($, on) => {
  mock.env(on, {})

  const calls: called[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())
  stepping(on, 'читаю диффы')

  on('http.fetch', (_$, event) => {
    calls.push({ url: event.url, body: body(event.init) })

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  const stream = $.turn.step({ turnId: 't-1', index: 0, model: 'opus', messageCount: 3 })

  for await (const _piece of stream) {
    // Куски идут мимо мода как есть: ни одного из них он в тему не отправляет.
  }

  await stream.result

  // Конец сессии — вызов, которого мод дожидается: всё, что он успел послать до него, уже здесь.
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  const messages = calls.filter(one => one.url === 'http://telegram-bridge/message')

  // Одно сообщение на дописанную реплику: куски «чита» и «ю диффы» своих запросов не родили, а
  // мысли и вызов инструмента в тему не пошли вовсе.
  expect(messages.length).toBe(1)
  expect(messages[0]?.body).toEqual({ text: 'читаю диффы' })
})

test('две реплики подряд дают две отправки, а не одну склеенную', async ($, on) => {
  mock.env(on, {})

  const texts: unknown[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  let said = 0

  on('turn.step', async function* (_$, event) {
    said += 1

    yield { kind: 'text' as const, index: 0, text: said === 1 ? 'читаю' : 'правлю' }

    return {
      turnId: event.turnId,
      index: event.index,
      answer: said === 1 ? 'читаю' : 'правлю',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: null,
    }
  })

  on('http.fetch', (_$, event) => {
    if (event.url === 'http://telegram-bridge/message') {
      texts.push(body(event.init).text)
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 't-1', index, model: 'opus', messageCount: 3 })

    for await (const _piece of stream) {
      // куски мимо
    }

    await stream.result
  }

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(texts).toEqual(['читаю', 'правлю'])
})

test('шаг хода отправкой реплики не держится', async ($, on) => {
  mock.env(on, {})

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  let release: (() => void) | undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })

  let seen: (() => void) | undefined
  const asked = new Promise<void>(resolve => {
    seen = resolve
  })

  linked(on, () => opened?.())
  stepping(on, 'читаю диффы')

  // Отправка реплики виснет: служба не отвечает на неё вовсе, пока тест её не отпустит.
  on('http.fetch', async (_$, event) => {
    if (event.url === 'http://telegram-bridge/message') {
      seen?.()

      await held
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  const stream = $.turn.step({ turnId: 't-1', index: 0, model: 'opus', messageCount: 3 })

  for await (const _piece of stream) {
    // куски мимо
  }

  // Шаг хода кончился, хотя служба отправку ещё не подтвердила: ждал бы мод её ответа, тест встал
  // бы здесь навсегда.
  await stream.result
  await asked

  release?.()
})

test('шаг без видимого текста в тему ничего не отправляет', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  // Шаг только с вызовом инструмента: видимого текста у ответа нет, и `answer` пуст.
  on('turn.step', async function* (_$, event) {
    yield { kind: 'tool' as const, index: 0, id: 'tu-1', name: 'Read' }
    yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null }

    return {
      turnId: event.turnId,
      index: event.index,
      answer: '',
      toolUses: [{ name: 'Read', input: { file_path: 'a.go' } }],
      stopReason: 'tool_use' as const,
      usage: null,
    }
  })

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  const stream = $.turn.step({ turnId: 't-4', index: 0, model: 'opus', messageCount: 3 })

  for await (const _piece of stream) {
    // куски мимо
  }

  await stream.result

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual(['http://telegram-bridge/bye'])
})

test('прерванный шаг в тему не уходит: недописанная реплика дописанной не является', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())

  // Владелец нажал Escape посреди реплики: текст уже начался, но конца ответа клиент не назвал —
  // `stopReason` равен `null`, и такой текст в тему не идёт.
  on('turn.step', async function* (_$, event) {
    yield { kind: 'text' as const, index: 0, text: 'читаю ди' }

    return {
      turnId: event.turnId,
      index: event.index,
      answer: 'читаю ди',
      toolUses: [],
      stopReason: null,
      usage: null,
    }
  })

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  const stream = $.turn.step({ turnId: 't-5', index: 0, model: 'opus', messageCount: 3 })

  for await (const _piece of stream) {
    // куски мимо
  }

  await stream.result

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual(['http://telegram-bridge/bye'])
})

test('реплика подагента в тему не уходит', async ($, on) => {
  mock.env(on, {})

  const paths: string[] = []

  let opened: (() => void) | undefined
  const waiting = new Promise<void>(resolve => {
    opened = resolve
  })

  linked(on, () => opened?.())
  stepping(on, 'отчёт подагента')

  on('http.fetch', (_$, event) => {
    paths.push(event.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await waiting

  const stream = $.turn.step({
    turnId: 't-3',
    index: 0,
    model: 'opus',
    messageCount: 3,
    agentId: 'a-1',
  })

  for await (const _piece of stream) {
    // куски мимо
  }

  await stream.result

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })

  expect(paths).toEqual(['http://telegram-bridge/bye'])
})

/** CHAT — название чата, которое клиент кладёт во вход классического хука. */
const CHAT = 'Проверка моста'

/**
 * reporter отвечает за `http.fetch` мода и помнит, что и куда ушло. Извещения уходят без
 * ожидания, поэтому тест ждёт нужного числа коротких запросов, а не гадает по оборотам очереди.
 */
const reporter = (on: On): { sent: called[]; wait: (count: number) => Promise<void> } => {
  const sent: called[] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []

  on('http.fetch', (_$, event) => {
    sent.push({ url: event.url, body: body(event.init) })

    for (const waiter of [...waiters]) {
      if (sent.length < waiter.count) continue

      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  const wait = async (count: number): Promise<void> => {
    if (sent.length >= count) return

    await new Promise<void>(resolve => {
      waiters.push({ count, resolve })
    })
  }

  return { sent, wait }
}

/**
 * hanging держит подкоманду живой до конца теста: соединение кончается по `bye` мода или по
 * остановке клиентом, и без этого выдача закрылась бы раньше извещений.
 */
const hanging = (on: On): (() => void) => {
  let halted: (() => void) | undefined
  const ended = new Promise<void>(resolve => {
    halted = resolve
  })

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n` }

    await ended

    return { value: { code: 0, signal: null } }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  return () => halted?.()
}

test('название чата уходит службе и переименовывает тему', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))

  const halt = hanging(on)
  const said = reporter(on)

  // Классический хук приходит раньше `session.start`: вход поднимается уже после него, и название
  // уезжает службе, как только вход назван.
  await $.classic.SessionStart({ session_title: CHAT })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await said.wait(1)

  expect(said.sent[0]).toEqual({ url: 'http://telegram-bridge/name', body: { name: CHAT } })

  // Переименование чата видно на следующем слове владельца, набранном в терминале.
  await $.classic.UserPromptSubmit({ prompt: 'ещё', session_title: 'Новое имя' })
  await said.wait(2)

  expect(said.sent[1]).toEqual({ url: 'http://telegram-bridge/name', body: { name: 'Новое имя' } })

  halt()
})

test('то же название чата второй раз службе не называется', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))

  const halt = hanging(on)
  const said = reporter(on)

  await $.classic.SessionStart({ session_title: CHAT })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await said.wait(1)

  await $.classic.UserPromptSubmit({ prompt: 'ещё', session_title: CHAT })

  expect(said.sent).toEqual([{ url: 'http://telegram-bridge/name', body: { name: CHAT } }])

  halt()
})

/**
 * commands — заготовка движка под командами режима: команда регистрируется, `/away` и `/here`
 * зовут подкоманду моста, а движок команду не исполняет — её обслуживает сам мод.
 */
const commands = (
  on: On,
): {
  registered: Array<{ name: string; immediate?: boolean; argumentHint?: string }>
  spawned: string[]
  engineRuns: number
  submits: number
  halt: () => void
} => {
  const registered: Array<{ name: string; immediate?: boolean; argumentHint?: string }> = []
  const spawned: string[] = []
  let engineRuns = 0
  let submits = 0
  let halted: (() => void) | undefined
  const ended = new Promise<void>(resolve => {
    halted = resolve
  })

  on('command.register', (_$, event) => {
    registered.push(event)

    return { value: { command: event.name } }
  })

  on('process.spawn', async function* (_$, event) {
    if (event.argv.includes('link')) {
      yield { stream: 'stdout' as const, text: `${ready}\n` }

      await ended

      return { value: { code: 0, signal: null } }
    }

    spawned.push(event.argv.join(' '))
    yield { stream: 'stdout' as const, text: 'режим включён, тема «проба» (7)\n' }

    return { value: { code: 0, signal: null } }
  })

  // Движок под модом: команду он не исполняет. Позови мод `next`, ответ пришёл бы отсюда, и
  // команда пошла бы ходом модели.
  on('command.run', () => {
    engineRuns += 1

    return { text: 'движок исполнил команду' }
  })

  on('prompt.submit', () => {
    submits += 1

    return { text: 'ход модели' }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  return {
    registered,
    spawned,
    get engineRuns() {
      return engineRuns
    },
    get submits() {
      return submits
    },
    halt: () => halted?.(),
  }
}

test('команды режима зарегистрированы на старте и не тратят хода модели', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const rig = commands(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  expect(rig.registered).toEqual([
    { name: 'away', description: expect.any(String), argumentHint: '[имя темы]', immediate: true },
    { name: 'here', description: expect.any(String), immediate: true },
  ])

  const answer = await $.command.run({ command: 'away', args: 'тема' })

  expect(answer).toEqual({ text: 'режим включён, тема «проба» (7)' })
  expect(rig.spawned).toEqual(['telegram-bridge away on тема --session s-1'])

  // Ни `next`, ни задания модели: ответ пришёл от мода, движок команду не исполнял. Поля `context`
  // в ответе нет — в контекст модели команда ничего не кладёт.
  expect(rig.engineRuns).toBe(0)
  expect(rig.submits).toBe(0)
  expect(Object.keys(answer as object)).not.toContain('context')

  rig.halt()
})

test('/here зовёт снятие режима и тоже не будит модель', async ($, on) => {
  mock.env(on, {})
  bottom(on)

  const rig = commands(on)

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const answer = await $.command.run({ command: 'here' })

  expect(answer).toEqual({ text: 'режим включён, тема «проба» (7)' })
  expect(rig.spawned).toEqual(['telegram-bridge away off --session s-1'])
  expect(rig.engineRuns).toBe(0)
  expect(rig.submits).toBe(0)

  rig.halt()
})

/** unlinkedRig — движок, у которого подкоманда `link` соединения не открыла: как именно, решает `link`. */
const unlinkedRig = (on: On, link: () => AsyncGenerator<{ stream: 'stderr'; text: string }, { code: number }>) => {
  const noticed: string[] = []
  const spawned: string[] = []

  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('process.spawn', async function* (_$, event) {
    if (event.argv.includes('link')) {
      const { code } = yield* link()

      return { value: { code, signal: null } }
    }

    spawned.push(event.argv.join(' '))

    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', (_$, event) => {
    noticed.push(event.text)

    return { value: undefined }
  })
  on('ui.status', (_$, event) => {
    noticed.push(event.text)

    return { value: undefined }
  })

  return { noticed, spawned }
}

test('не настроен: на старте тихо, причину называет /away и режим не включает', async ($, on) => {
  mock.env(on, {})

  let done: (() => void) | undefined
  const finished = new Promise<void>(resolve => {
    done = resolve
  })

  bottom(on, text => {
    if (text.includes('путь к настройкам не назван') && text.startsWith('мост Telegram')) {
      done?.()
    }
  })

  const rig = unlinkedRig(on, async function* () {
    yield { stream: 'stderr' as const, text: 'telegram-bridge: путь к настройкам не назван\n' }

    return { code: 2 }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await finished

  expect(rig.noticed).toEqual([])
  expect(await $.command.run({ command: 'away', args: '' })).toEqual({
    text: 'режим не включён: telegram-bridge: путь к настройкам не назван',
  })
  expect(rig.spawned).toEqual([])
})

test('бинаря нет: на старте тихо, причину называет /away', async ($, on) => {
  mock.env(on, {})

  let done: (() => void) | undefined
  const finished = new Promise<void>(resolve => {
    done = resolve
  })

  bottom(on, text => {
    if (text.includes('не поднялось')) {
      done?.()
    }
  })

  const rig = unlinkedRig(on, async function* () {
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await finished

  expect(rig.noticed).toEqual([])
  expect(await $.command.run({ command: 'away', args: '' })).toEqual({
    text: expect.stringContaining('режим не включён: соединение со службой не поднялось: '),
  })
  expect(rig.spawned).toEqual([])
})

test('канал был и пропал: владелец слышит сразу, /away режим не включает', async ($, on) => {
  mock.env(on, {})
  // Часы стоят: новый запуск подкоманды через паузу этот тест не смотрит.
  mock.clock(on)

  const toasts: string[] = []
  const spawned: string[] = []

  let told: (() => void) | undefined
  const heard = new Promise<void>(resolve => {
    told = resolve
  })

  bottom(on)

  on('command.register', (_$, event) => ({ value: { command: event.name } }))
  on('process.spawn', async function* (_$, event) {
    if (event.argv.includes('link')) {
      yield { stream: 'stdout' as const, text: `${ready}\n` }

      return { value: { code: 1, signal: null } }
    }

    spawned.push(event.argv.join(' '))

    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', (_$, event) => {
    toasts.push(event.text)
    told?.()

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await heard

  expect(toasts).toEqual(['мост Telegram: канала нет, соединение кончилось (код 1); поднимаю заново'])
  expect(await $.command.run({ command: 'away', args: '' })).toEqual({
    text: 'режим не включён: канала нет, соединение кончилось (код 1)',
  })
  expect(spawned).toEqual([])
})

test('петля падений службы сразу после приветствия: одна строка о пропаже, без «канал вернулся» по кругу', async ($, on) => {
  expect(await streamed($, on, [ready, lost, absent, ready, lost, ready, lost, ready])).toEqual([
    'мост Telegram: службы нет 30 с, жду её и подключусь сам',
  ])
})

test('реплика, не дошедшая до темы, слышна владельцу в терминале', async ($, on) => {
  const undelivered = JSON.stringify({
    event: 'undelivered',
    text: 'реплик агента не доставлено в тему: 1 — служба отбила реплику',
  })

  expect(await streamed($, on, [ready, undelivered])).toEqual([
    'мост Telegram: реплик агента не доставлено в тему: 1 — служба отбила реплику',
  ])
})

test('повтор принятой доставки в сессию второй раз не подаётся, а подтверждается', async ($, on) => {
  mock.env(on, {})
  mock.clock(on)
  bottom(on)

  const submitted: string[] = []
  const acks: acked[] = []

  let both: (() => void) | undefined
  const confirmed = new Promise<void>(resolve => {
    both = resolve
  })

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${ready}\n${word}\n${word}\n` }

    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })

  on('prompt.submit', (_$, event) => {
    submitted.push(event.text)

    return { text: event.text }
  })

  on('http.fetch', (_$, event) => {
    if (event.url.endsWith('/ack')) {
      acks.push(sent(event.init))

      if (acks.length === 2) {
        both?.()
      }
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await confirmed

  expect(submitted.length).toBe(1)
  expect(acks).toEqual([
    { delivery_id: 'd-1', outcome: 'accepted', detail: '' },
    { delivery_id: 'd-1', outcome: 'accepted', detail: '' },
  ])
})

test('подъём, не открывший соединение после «поднимаю заново», слышен владельцу', async ($, on) => {
  mock.env(on, {})

  const clock = mock.clock(on)
  const toasts: string[] = []
  let spawned = 0

  bottom(on)

  on('process.spawn', async function* () {
    spawned += 1

    if (spawned === 1) {
      yield { stream: 'stdout' as const, text: `${ready}\n` }

      return { value: { code: 1, signal: null } }
    }

    yield { stream: 'stderr' as const, text: 'telegram-bridge: путь к настройкам не назван\n' }

    return { value: { code: 2, signal: null } }
  })

  on('ui.toast', (_$, event) => {
    toasts.push(event.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(5000)
  await clock.advance(60_000)

  expect(spawned).toBe(2)
  expect(toasts).toEqual([
    'мост Telegram: канала нет, соединение кончилось (код 1); поднимаю заново',
    'мост Telegram: канал не поднялся: telegram-bridge: путь к настройкам не назван',
  ])
})

test('конец сессии снимает отложенный подъём подкоманды', async ($, on) => {
  mock.env(on, {})

  const clock = mock.clock(on)
  let spawned = 0

  bottom(on)

  on('process.spawn', async function* () {
    spawned += 1
    yield { stream: 'stdout' as const, text: `${ready}\n` }

    return { value: { code: 1, signal: null } }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's-1', resume: { sessionId: 's-1' } })
  await clock.advance(60_000)

  expect(spawned).toBe(1)
})

test('реплики без подкоманды между смертью и подъёмом уходят новой подкоманде по порядку', async ($, on) => {
  mock.env(on, {})

  const clock = mock.clock(on)
  const messages: string[] = []
  let spawned = 0

  bottom(on)
  stepping(on, 'первая')

  on('process.spawn', async function* () {
    spawned += 1

    if (spawned === 1) {
      yield { stream: 'stdout' as const, text: `${ready}\n` }

      return { value: { code: 1, signal: null } }
    }

    yield { stream: 'stdout' as const, text: `${ready}\n` }

    await new Promise<void>(() => {})

    return { value: { code: 0, signal: null } }
  })

  on('http.fetch', (_$, event) => {
    if (event.url.endsWith('/message')) {
      messages.push(String(body(event.init).text))
    }

    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })

  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const stream = $.turn.step({ turnId: 't-1', index: 0, model: 'opus', messageCount: 3 })

  for await (const _piece of stream) {
    // шаг хода дочитывается до конца
  }

  await stream.result

  expect(messages).toEqual([])

  await clock.advance(5000)

  expect(messages).toEqual(['первая'])
})
