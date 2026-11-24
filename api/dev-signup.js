// berelax.space/dev developer account creation (username + password).
// Supabase Auth only knows e-mail + password, so a username maps to an
// internal address <username>@dev.berelax.space that never receives mail.
// The account is created confirmed through the admin API, so it needs the
// service role key, which lives only in Vercel's environment
// (SUPABASE_SERVICE_ROLE_KEY) and never reaches the browser.
// Sign-up needs the reference code Lu set in Vercel (DEV_INVITE_CODE) and
// closes by itself once the first developer exists; set DEV_SIGNUP_OPEN=1 in
// Vercel to let one more person in (still with the code).
import process from 'node:process'
import { createHash, timingSafeEqual } from 'node:crypto'

const SUPABASE_URL = 'https://kpoeifwhechqofqybrbr.supabase.co'
const USERNAME = /^[a-z0-9._-]{3,24}$/
export const devEmail = (username) => `${username}@dev.berelax.space`
const digest = (value) => createHash('sha256').update(String(value)).digest()
const sameCode = (given, expected) => timingSafeEqual(digest(given), digest(expected))

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  const url = process.env.VITE_SUPABASE_URL || SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  const invite = process.env.DEV_INVITE_CODE
  if (!service || !invite) return res.status(503).json({ error: 'kayıt henüz ayarlanmadı' })
  let body = req.body
  try { if (typeof body === 'string') body = JSON.parse(body) } catch { body = null }
  const username = String(body?.username ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')
  if (!sameCode(String(body?.code ?? '').trim(), invite.trim())) return res.status(403).json({ error: 'referans kodu geçersiz' })
  if (!USERNAME.test(username)) return res.status(400).json({ error: 'kullanıcı adı 3–24 karakter: harf, rakam, . _ -' })
  if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'şifre en az 10 karakter olmalı' })

  const headers = { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }
  const rpc = (name, args = {}) => fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) })

  const count = await rpc('dev_member_count')
  if (!count.ok) return res.status(503).json({ error: 'geliştirici tabloları henüz kurulmadı' })
  if (Number(await count.json()) > 0 && process.env.DEV_SIGNUP_OPEN !== '1') return res.status(403).json({ error: 'kayıt kapalı' })

  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', headers,
    body: JSON.stringify({ email: devEmail(username), password, email_confirm: true, user_metadata: { dev_username: username } }),
  })
  if (!created.ok) return res.status(created.status === 422 ? 409 : 502).json({ error: created.status === 422 ? 'bu kullanıcı adı alınmış' : 'hesap açılamadı' })
  const user = await created.json()

  const added = await rpc('dev_add_member', { p_user_id: user.id, p_username: username })
  if (!added.ok) {
    await fetch(`${url}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers })
    return res.status(409).json({ error: 'bu kullanıcı adı alınmış' })
  }
  return res.status(200).json({ ok: true })
}
