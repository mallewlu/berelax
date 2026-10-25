// Bubble Ar-Ge measurement sink (berelax.space/bubble-arge/?olcum=1).
// Stores each device run in Supabase table bubble_olcum (insert-only RLS).
// Uses the project's existing public Supabase env vars; no extra secret.
import process from 'node:process'

const MAX_BYTES = 100_000

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end()
    return
  }
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    res.status(500).end()
    return
  }
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
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ report }),
  })
  res.status(saved.ok ? 200 : 502).end(saved.ok ? 'ok' : '')
}
