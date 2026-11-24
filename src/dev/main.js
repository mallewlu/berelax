import { createClient } from '@supabase/supabase-js'
import { createBubbleExperience } from '../bubble/core/bubbleExperience.js'
import { newSeed } from '../bubble/core/genome.js'

// Public project URL and publishable key (the same ones api/olcum.js ships);
// every developer table is closed by RLS to anyone who is not a dev member.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://kpoeifwhechqofqybrbr.supabase.co'
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_hmiqyHYMqITRcXILbvMsoA_0wPXxp34'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: 'berelax-dev-auth' } })
const devEmail = (username) => `${username}@dev.berelax.space`

const $ = (id) => document.getElementById(id)
const buttons = [...document.querySelectorAll('[data-open]')]
const windows = [...document.querySelectorAll('.window')]
const hint = $('hint')
let bubble = null
let lastButton = null
let member = null // { username } once signed in as a developer
let mode = 'motor'

try { bubble = createBubbleExperience({ canvas: $('bubble'), detailMode: 'flow-full' }) }
catch (error) { hint.textContent = 'baloncuk bu cihazda açılamadı.'; console.error(error) }
const hintTimer = setTimeout(() => hint.classList.add('is-hidden'), 5000)

// ---- windows: open over the same screen, never a new page ----
function closeWindows() {
  for (const panel of windows) panel.hidden = true
  for (const button of buttons) button.setAttribute('aria-expanded', 'false')
}
for (const button of buttons) button.addEventListener('click', () => {
  const panel = $(button.dataset.open)
  const show = panel.hidden
  closeWindows()
  if (!show) return
  panel.hidden = false
  button.setAttribute('aria-expanded', 'true')
  lastButton = button
  if (panel.id === 'feedback') { $('note-where').textContent = `${mode === 'selection' ? 'baloncuk seçimi' : 'güncel motor'} için not`; loadNotes() }
  panel.querySelector('.close').focus()
})
for (const panel of windows) panel.querySelector('.close').addEventListener('click', () => { closeWindows(); lastButton?.focus() })
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && windows.some((panel) => !panel.hidden)) { closeWindows(); lastButton?.focus() }
})

// ---- account ----
let signingUp = false
function setSignup(on) {
  signingUp = on
  $('account-title').textContent = on ? 'hesap oluştur' : 'giriş'
  $('repeat-row').hidden = !on
  $('code-row').hidden = !on
  $('password').autocomplete = on ? 'new-password' : 'current-password'
  $('auth-submit').textContent = on ? 'hesabı oluştur' : 'giriş yap'
  $('auth-switch').textContent = on ? 'zaten hesabım var' : 'hesap oluştur'
  $('auth-msg').textContent = ''
}
$('auth-switch').addEventListener('click', () => setSignup(!signingUp))
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const username = $('username').value.trim().toLowerCase()
  const password = $('password').value
  const msg = $('auth-msg')
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) { msg.textContent = 'kullanıcı adı 3–24 karakter: harf, rakam, . _ -'; return }
  if (signingUp && password.length < 10) { msg.textContent = 'şifre en az 10 karakter olmalı'; return }
  if (signingUp && password !== $('password2').value) { msg.textContent = 'şifreler aynı değil'; return }
  const code = $('code').value.trim()
  if (signingUp && !code) { msg.textContent = 'referans kodunu gir'; return }
  $('auth-submit').disabled = true
  msg.textContent = signingUp ? 'hesap açılıyor…' : 'giriş yapılıyor…'
  try {
    if (signingUp) {
      const res = await fetch('/api/dev-signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, code }) })
      if (!res.ok) { msg.textContent = (await res.json().catch(() => null))?.error ?? 'hesap açılamadı'; return }
    }
    const { error } = await supabase.auth.signInWithPassword({ email: devEmail(username), password })
    if (error) { msg.textContent = 'kullanıcı adı veya şifre yanlış'; return }
    $('password').value = ''; $('password2').value = ''; $('code').value = ''
  } catch { msg.textContent = 'bağlantı kurulamadı' }
  finally { $('auth-submit').disabled = false }
})
$('sign-out').addEventListener('click', () => supabase.auth.signOut())

async function refreshMember(session) {
  member = null
  if (session) {
    const { data } = await supabase.rpc('dev_username')
    if (data) member = { username: data }
  }
  const inside = Boolean(member)
  $('auth-form').hidden = inside
  $('signed-in').hidden = !inside
  $('who').textContent = member ? `@${member.username}` : ''
  $('account-button').textContent = inside ? 'hesap' : 'giriş'
  if (inside) $('account-title').textContent = 'hesap'
  else setSignup(signingUp)
  if (session && !inside) $('auth-msg').textContent = 'bu hesap geliştirici değil.'
  $('works-lock').hidden = inside
  for (const el of document.querySelectorAll('[data-mode], #note, #note-save')) el.disabled = !inside
  if (inside) await loadQueue()
  else if (mode !== 'motor') setMode('motor')
}
supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => refreshMember(session), 0) })

// ---- notes: stored in dev_notes, read back here and by Claude/Codex ----
async function loadNotes() {
  const list = $('notes')
  if (!member) { list.replaceChildren(); $('note-msg').textContent = 'not yazmak için giriş yap.'; return }
  $('note-msg').textContent = ''
  const { data, error } = await supabase.from('dev_notes').select('author,screen,body,created_at').order('created_at', { ascending: false }).limit(30)
  if (error) { $('note-msg').textContent = 'notlar okunamadı'; return }
  list.replaceChildren(...data.map((note) => {
    const li = document.createElement('li')
    const meta = document.createElement('small')
    meta.textContent = `${note.screen} · ${new Date(note.created_at).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}`
    li.append(meta, note.body)
    return li
  }))
}
$('note-save').addEventListener('click', async () => {
  const body = $('note').value.trim()
  if (!body || !member) return
  $('note-save').disabled = true
  const snap = bubble?.snapshot?.()
  const { error } = await supabase.from('dev_notes').insert({
    screen: mode === 'selection' ? 'baloncuk-secimi' : 'guncel-motor',
    body,
    context: { seed: snap?.seed ?? null, age: snap ? Math.round(snap.ageSeconds) : null, width: innerWidth, height: innerHeight, touch: matchMedia('(pointer: coarse)').matches },
  })
  $('note-save').disabled = false
  if (error) { $('note-msg').textContent = 'kaydedilemedi'; return }
  $('note').value = ''
  $('note-msg').textContent = 'kaydedildi.'
  loadNotes()
})

// ---- daily selection: 12 new bubbles a day, kept in dev_state ----
const DAILY = 12
const DAY = 86400000
const today = () => { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY) }
let queue = null
async function loadQueue() {
  const { data } = await supabase.from('dev_state').select('value').eq('key', 'secim').maybeSingle()
  const saved = data?.value
  queue = saved?.version === 1 ? saved : { version: 1, lastDay: today() - 1, queue: [], history: [] }
  for (let day = queue.lastDay + 1; day <= today(); day++) {
    for (let i = 0; i < DAILY; i++) queue.queue.push({ seed: newSeed(), day })
    queue.lastDay = day
  }
  await saveQueue()
}
async function saveQueue() {
  const { error } = await supabase.from('dev_state').upsert({ key: 'secim', value: queue, updated_at: new Date().toISOString() }, { onConflict: 'user_id,key' })
  $('queue-status').dataset.error = error ? '1' : ''
}
function showQueue() {
  const entry = queue?.queue[0]
  const failed = $('queue-status').dataset.error === '1'
  $('queue-status').textContent = failed ? 'seçim kaydedilemedi' : entry ? `${queue.queue.length} baloncuk bekliyor` : 'bugünlük bitti'
  for (const b of document.querySelectorAll('[data-choice]')) b.disabled = !entry
  $('undo').disabled = !queue?.history.length
  if (entry && bubble) bubble.birth(entry.seed)
}
async function choose(choice) {
  if (mode !== 'selection' || !queue?.queue.length) return
  const entry = queue.queue.shift()
  queue.history.push({ ...entry, choice, at: Date.now() })
  showQueue(); await saveQueue(); showQueue()
}
async function undo() {
  const entry = queue?.history.pop()
  if (!entry) return
  queue.queue.unshift({ seed: entry.seed, day: entry.day })
  showQueue(); await saveQueue(); showQueue()
}
for (const b of document.querySelectorAll('[data-choice]')) b.addEventListener('click', () => choose(b.dataset.choice))
$('undo').addEventListener('click', undo)
document.addEventListener('keydown', (event) => {
  if (mode !== 'selection' || windows.some((panel) => !panel.hidden)) return
  if (event.key === 'ArrowLeft') choose('geç')
  else if (event.key === 'ArrowRight') choose('seç')
})
// Edge strips take the swipe so the film itself stays free for touching.
for (const edge of document.querySelectorAll('[data-edge]')) {
  let start = null
  edge.addEventListener('pointerdown', (e) => { if (e.isPrimary) { start = { x: e.clientX, y: e.clientY }; edge.setPointerCapture(e.pointerId) } })
  edge.addEventListener('pointerup', (e) => {
    if (!start) return
    const dx = e.clientX - start.x, dy = e.clientY - start.y
    start = null
    if (Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy) * 1.4) choose(dx > 0 ? 'seç' : 'geç')
  })
  edge.addEventListener('pointercancel', () => { start = null })
}

function setMode(next) {
  mode = next
  const selection = mode === 'selection'
  $('choices').hidden = !selection
  for (const edge of document.querySelectorAll('[data-edge]')) edge.hidden = !selection
  hint.hidden = selection
  if (selection) showQueue()
  else bubble?.birth(newSeed())
}
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
  if (!member) return
  setMode(button.dataset.mode)
  closeWindows(); lastButton?.focus()
})

window.addEventListener('pagehide', () => { clearTimeout(hintTimer); bubble?.dispose() }, { once: true })
