// Verify the email CODE (OTP) sign-in: request -> 6-digit code -> verify ->
// session; wrong code rejected; single-use; rate-limit lock; session works.
// Env: BASE_URL. Relies on TEST_MODE echoing the code in /auth/request.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
let pass = 0, fail = 0
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); ok ? pass++ : fail++ }
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function requestCode(email) { const r = await post('/auth/request', { email }); return { status: r.status, code: (await r.json()).code } }

try {
  const email = 'code-e2e-' + Date.now() + '@example.com'
  const { status, code } = await requestCode(email)
  check(status === 200 && /^\d{6}$/.test(code || ''), 'request -> 6-digit code', 'code ' + (code ? 'len ' + code.length : 'MISSING'))

  const wrong = await post('/auth/verify', { email, code: '000000' === code ? '111111' : '000000' })
  check(wrong.status === 403, 'wrong code rejected', 'HTTP ' + wrong.status)

  const good = await post('/auth/verify', { email, code })
  const gj = await good.json().catch(() => ({}))
  check(good.ok && gj.token, 'right code -> session token', 'HTTP ' + good.status)

  const reuse = await post('/auth/verify', { email, code })
  check(reuse.status === 403, 'code is single-use (reuse rejected)', 'HTTP ' + reuse.status)

  // session works
  const mine = await fetch(BASE + '/family/mine', { headers: { authorization: 'Bearer ' + gj.token } })
  check(mine.ok, 'session token reaches an authed route', 'HTTP ' + mine.status)

  // rate-limit lock: 5 wrong tries then locked
  const email2 = 'code-lock-' + Date.now() + '@example.com'
  await requestCode(email2)
  let lastStatus, lastErr
  for (let i = 0; i < 6; i++) { const r = await post('/auth/verify', { email: email2, code: '999999' }); lastStatus = r.status; lastErr = (await r.json()).error }
  check(/too many/i.test(lastErr || ''), 'locks after too many wrong tries', 'HTTP ' + lastStatus + ' "' + lastErr + '"')
} catch (e) { console.error('EXCEPTION', e && e.stack || e); fail++ }

console.log(`\nCode sign-in verify: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
