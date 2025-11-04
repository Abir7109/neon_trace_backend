import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import { MongoClient } from 'mongodb'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3001
const ORS_KEY = process.env.ORS_API_KEY
const MONGO_URI = process.env.MONGODB_URI

let db = null
let memLogs = []

if (MONGO_URI) {
  const client = new MongoClient(MONGO_URI)
  client.connect().then(() => {
    db = client.db()
    console.log('[db] connected')
  }).catch((e) => console.error('[db] connect error', e.message))
}

app.get('/', (req, res) => res.json({ ok: true, service: 'neon-trace-api' }))

app.get('/api/logs', async (req, res) => {
  try {
    if (db) {
      const logs = await db.collection('route_logs').find({}).sort({ createdAt: -1 }).limit(50).toArray()
      return res.json({ logs })
    } else {
      return res.json({ logs: memLogs.slice(-50).reverse() })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

app.post('/api/route', async (req, res) => {
  const { origin, destination, profile = 'driving-car' } = req.body || {}
  try {
    if (!ORS_KEY) throw new Error('Server missing ORS_API_KEY')
    if (!origin || !destination) throw new Error('origin/destination required')
    const a = toLL(origin)
    const b = toLL(destination)

    const t0 = Date.now()
    const url = `https://api.openrouteservice.org/v2/directions/${encodeURIComponent(profile)}/geojson`
    const body = {
      coordinates: [ [a.lng, a.lat], [b.lng, b.lat] ],
      instructions: false,
      options: { alternative_routes: { target_count: 3, share_factor: 0.6 } },
    }

    const resp = await axios.post(url, body, { headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' }, timeout: 20000 })
    const features = resp.data && resp.data.features ? resp.data.features : []
    if (!features.length) throw new Error('No route returned')

    // Pick shortest
    let best = features[0]
    for (const f of features) {
      if ((f.properties?.summary?.distance ?? Infinity) < (best.properties?.summary?.distance ?? Infinity)) best = f
    }

    const coords = (best.geometry?.coordinates || []).map(([lng, lat]) => ({ lat, lng }))
    const distance = best.properties?.summary?.distance ?? null
    const duration = best.properties?.summary?.duration ?? null

    const steps = [
      `origin=(${a.lat.toFixed(5)},${a.lng.toFixed(5)})`,
      `destination=(${b.lat.toFixed(5)},${b.lng.toFixed(5)})`,
      `profile=${profile}`,
      `alternatives_requested=3`,
    ]

    const doc = { origin: a, destination: b, profile, pathsAnalyzed: features.length, chosen: { distance, duration }, createdAt: new Date(), t: Date.now() - t0 }
    if (db) await db.collection('route_logs').insertOne(doc)
    else memLogs.push(doc)

    return res.json({
      route: { coordinates: coords, distance, duration },
      alternatives: features.length,
      analysis: { steps, pathsAnalyzed: features.length, algorithm: 'ORS-alternatives+selection' },
      waypoints: { origin: a, destination: b },
    })
  } catch (e) {
    console.error('[route] error', e.message)
    return res.status(500).json({ error: e.message })
  }
})

function toLL(x) {
  if (x && typeof x.lat === 'number' && typeof x.lng === 'number') return x
  if (Array.isArray(x) && x.length >= 2) {
    // accept [lat, lng] or [lng, lat] if explicitly marked
    const [a, b] = x
    // Heuristic: lat is between -90..90
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: +a, lng: +b }
    return { lat: +b, lng: +a }
  }
  throw new Error('invalid coordinate: ' + JSON.stringify(x))
}

app.listen(PORT, () => console.log(`[api] listening on :${PORT}`))
