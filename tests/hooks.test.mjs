import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('hook ask объявлен на вопрос рядом с модулем и зовёт мост', () => {
  const file = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))

  assert.ok(Array.isArray(file.modules) && file.modules.includes('./register.ts'), 'модуль сессии не объявлен')

  const asked = (file.hooks?.PreToolUse ?? []).filter((entry) => entry.matcher === 'AskUserQuestion')

  assert.equal(asked.length, 1, 'хук вопроса объявлен не один раз')
  assert.deepEqual(asked[0].hooks.map((hook) => hook.command), ['telegram-bridge hook ask'])
})

test('файлов команд у плагина больше нет: команды режима регистрирует модуль', async () => {
  const { existsSync } = await import('node:fs')

  assert.equal(existsSync(new URL('../commands', import.meta.url)), false, 'каталог commands ещё лежит')

  const module = readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')

  assert.match(module, /on\('command\.run', \{ command: COMMAND_AWAY \}/, 'команда away не обслуживается модулем')
  assert.match(module, /on\('command\.run', \{ command: COMMAND_HERE \}/, 'команда here не обслуживается модулем')
  assert.match(module, /\$\.command\.register\(/, 'команды не регистрируются модулем')
})
