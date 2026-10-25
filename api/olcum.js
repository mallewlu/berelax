// Bubble Ar-Ge measurement sink (berelax.space/meetbubble/?olcum=1).
// Stores each device run in Supabase table bubble_olcum (insert-only RLS).
// The publishable key is Supabase's public client key (safe to ship); the
// table only accepts inserts, nobody can read through it.
import process from 'node:process'

const MAX_BYTES = 100_000
const SUPABASE_URL = 'https://kpoeifwhechqofqybrbr.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_hmiqyHYMqITRcXILbvMsoA_0wPXxp34'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const url = process.env.VITE_SUPABASE_URL || SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY || SUPABASE_PUBLISHABLE_KEY
  let report = req.body
  try {
    if (typeof report === 'string') {
      if (report.length > MAX_BYTES) throw new Error('too large')
      report = JSON.parse(report)
    }
    if (!report || typeof report !== 'object' || !Array.isArray(report.results)) throw new Error('bad shape')
    if (JSON.stringify(report).length > MAX_BYTES) throw new Error('too large')
  } catch {
    res.status(400).end()
    return
  }
  const saved = await fetch(`${url}/rest/v1/bubble_olcum`, {
    method: 'POST',
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ report }),
  })
  res.status(saved.ok ? 200 : 502).end(saved.ok ? 'ok' : '')
}
