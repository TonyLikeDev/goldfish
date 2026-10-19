import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(f => f && fs.existsSync(f))

test('no file has leftover merge conflict markers', () => {
  const bad = files.filter(f => /\.(js|cjs|mjs|json|html|css|md|yml|nsh|plist)$/.test(f)
    && /^(<<<<<<< |>>>>>>> )/m.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})

// The renderer pages (bar.js, app.js) are not imported by any other test, so a broken one would otherwise ship.
test('every JavaScript file parses', () => {
  for (const f of files.filter(f => /\.(js|cjs|mjs)$/.test(f)))
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }), f)
})
