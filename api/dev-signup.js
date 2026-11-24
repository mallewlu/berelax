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
  try {
    return await signup(req, res)
  } catch (error) {
    // Name only: a header error's message would contain the secret key.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
    // Shape only, never the value: which kind of key and whether it holds
    // characters a header cannot carry (spaces, line breaks, non-ASCII).
    const shape = key.startsWith('sb_secret_') ? 'sb_secret' : key.startsWith('eyJ') ? 'jwt' : key.startsWith('sb_publishable_') ? 'publishable' : 'bilinmeyen'
    const bad = /[^\x21-\x7e]/.test(key) ? 'geçersiz karakter var' : 'karakterler temiz'
    const where = stage
    console.error('dev-signup crashed', error?.name, where, error?.cause?.code ?? '')
    return res.status(500).json({ error: `hesap açılamadı (${error?.name ?? 'error'} · adım: ${where} · anahtar: ${shape}, ${bad}${error?.cause?.code ? ' · ' + error.cause.code : ''})` })
  }
}

let stage = 'başlangıç'
async function signup(req, res) {
  stage = 'doğrulama'
  if (req.method !== 'POST') return res.status(405).end()
  const url = process.env.VITE_SUPABASE_URL || SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
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

  stage = 'üye sayısı'
  const count = await rpc('dev_member_count')
  if (count.status === 401 || count.status === 403) return res.status(503).json({ error: `sunucu anahtarı kabul edilmedi (${count.status})` })
  if (!count.ok) return res.status(503).json({ error: `geliştirici tabloları okunamadı (${count.status})` })
  if (Number(await count.json()) > 0 && process.env.DEV_SIGNUP_OPEN !== '1') return res.status(403).json({ error: 'kayıt kapalı' })

  stage = 'hesap oluşturma'
  const created = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST', headers,
    body: JSON.stringify({ email: devEmail(username), password, email_confirm: true, user_metadata: { dev_username: username } }),
  })
  if (!created.ok) {
    // Supabase's own error code (no secrets) so the page can say why.
    const reason = await created.json().catch(() => ({}))
    const code = String(reason.error_code ?? reason.code ?? created.status)
    console.error('dev-signup: auth admin create failed', created.status, code, reason.msg ?? reason.message ?? '')
    const known = { email_exists: 'bu kullanıcı adı alınmış', user_already_exists: 'bu kullanıcı adı alınmış', weak_password: 'şifre yeterince güçlü değil' }
    return res.status(created.status === 422 ? 409 : 502).json({ error: known[code] ?? `hesap açılamadı (${code})`, code })
  }
  const user = await created.json()

  stage = 'üyelik ekleme'
  const added = await rpc('dev_add_member', { p_user_id: user.id, p_username: username })
  if (!added.ok) {
    const reason = await added.json().catch(() => ({}))
    console.error('dev-signup: add member failed', added.status, reason.code ?? '', reason.message ?? '')
    await fetch(`${url}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers })
    return res.status(409).json({ error: reason.code === '23505' ? 'bu kullanıcı adı alınmış' : `üyelik eklenemedi (${reason.code ?? added.status})` })
  }
  return res.status(200).json({ ok: true })
}
