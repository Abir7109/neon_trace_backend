import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import { MongoClient } from 'mongodb'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())
app.set('trust proxy', true)

const PORT = process.env.PORT || 3001
const ORS_KEY = process.env.ORS_API_KEY
const MONGO_URI = process.env.MONGODB_URI

let db = null
let memLogs = []
let memDevices = new Map()
let memLocs = []

if (MONGO_URI) {
  const client = new MongoClient(MONGO_URI)
  client.connect().then(() => {
    const dbName = getDbNameFromUri(MONGO_URI)
    db = client.db(dbName)
    console.log('[db] connected', dbName ? `db=${dbName}` : '')
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

// Admin: list devices
app.get('/api/devices', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit||'200')))
    if (db) {
      const rows = await db.collection('devices').find({}).sort({ updatedAt: -1 }).limit(limit).toArray()
      return res.json({ devices: rows })
    } else {
      const arr = Array.from(memDevices.values()).sort((a,b)=> (b.updatedAt?.getTime?.()||0)-(a.updatedAt?.getTime?.()||0)).slice(0, limit)
      return res.json({ devices: arr })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Admin: list device locations (recent)
app.get('/api/device_locations', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(5000, parseInt(req.query.limit||'500')))
    const deviceId = (req.query.deviceId||'').trim()
    const since = req.query.since ? new Date(req.query.since) : null
    if (db) {
      const q = {}
      if (deviceId) q.deviceId = deviceId
      if (since && !isNaN(+since)) q.createdAt = { $gte: since }
      const rows = await db.collection('device_locations').find(q).sort({ createdAt: -1 }).limit(limit).toArray()
      return res.json({ locations: rows })
    } else {
      let arr = memLocs.slice()
      if (deviceId) arr = arr.filter((x)=>x.deviceId===deviceId)
      if (since && !isNaN(+since)) arr = arr.filter((x)=> x.createdAt >= since)
      arr.sort((a,b)=> b.createdAt - a.createdAt)
      return res.json({ locations: arr.slice(0, limit) })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Admin: block/unblock device
app.post('/api/admin/block', async (req, res) => {
  try {
    const { deviceId, blocked } = req.body||{}
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    const set = { blocked: !!blocked, updatedAt: new Date() }
    if (db) {
      await db.collection('devices').updateOne({ deviceId }, { $set: set })
      const saved = await db.collection('devices').findOne({ deviceId })
      return res.json({ me: saved })
    } else {
      const ex = memDevices.get(deviceId) || { deviceId }
      const next = { ...ex, ...set }
      memDevices.set(deviceId, next)
      return res.json({ me: next })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Admin: quick stats
app.get('/api/stats', async (req, res) => {
  try {
    if (db) {
      const [devices, locations, logs] = await Promise.all([
        db.collection('devices').countDocuments({}),
        db.collection('device_locations').countDocuments({}),
        db.collection('route_logs').countDocuments({}),
      ])
      return res.json({ counts: { devices, locations, logs } })
    } else {
      return res.json({ counts: { devices: memDevices.size, locations: memLocs.length, logs: memLogs.length } })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Get or upsert a device profile
app.get('/api/me', async (req, res) => {
  try {
    const deviceId = (req.query.deviceId || '').toString().trim()
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    if (db) {
      const doc = await db.collection('devices').findOne({ deviceId })
      return res.json({ me: doc || null })
    } else {
      const doc = memDevices.get(deviceId) || null
      return res.json({ me: doc })
    }
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

app.post('/api/me', async (req, res) => {
  try {
    const { deviceId, deviceName, location } = req.body || {}
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    let ll = null
    try { if (location != null) ll = toLL(location) } catch {}
    const ip = getIp(req)
    const base = { deviceId, deviceName: (deviceName || '').toString().slice(0, 100), ip, updatedAt: new Date() }
    const doc = ll ? { ...base, lastLocation: ll } : base
    if (db) {
      await db.collection('devices').updateOne({ deviceId }, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
      if (ll) {
        await db.collection('device_locations').insertOne({ deviceId, lat: ll.lat, lng: ll.lng, ip, createdAt: new Date() })
      }
      const saved = await db.collection('devices').findOne({ deviceId })
      return res.json({ me: saved })
    } else {
      const existing = memDevices.get(deviceId)
      memDevices.set(deviceId, existing ? { ...existing, ...doc } : { ...doc, createdAt: new Date() })
      if (ll) memLocs.push({ deviceId, lat: ll.lat, lng: ll.lng, ip, createdAt: new Date() })
      return res.json({ me: memDevices.get(deviceId) })
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
    const baseBody = {
      coordinates: [ [a.lng, a.lat], [b.lng, b.lat] ],
      instructions: false,
    }
    let body = { ...baseBody, options: { alternative_routes: { target_count: 3, share_factor: 0.6 } } }

    let data
    try {
      const resp = await axios.post(url, body, { headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' }, timeout: 20000 })
      data = resp.data
    } catch (e) {
      // Fallback: retry without alternatives if ORS rejects options (400)
      if (e.response && e.response.status === 400) {
        const resp2 = await axios.post(url, baseBody, { headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json' }, timeout: 20000 })
        data = resp2.data
      } else {
        throw e
      }
    }

    const features = data && data.features ? data.features : []
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
    if (e.response && e.response.data) {
      const status = e.response.status || 500
      console.error('[route] error', status, JSON.stringify(e.response.data))
      return res.status(status).json({ error: 'ors_error', details: e.response.data })
    }
    console.error('[route] error', e.message)
    return res.status(500).json({ error: e.message })
  }
})

function toLL(x) {
  if (x && typeof x.lat === 'number' && typeof x.lng === 'number') return { lat: +x.lat, lng: +x.lng }
  if (Array.isArray(x) && x.length >= 2) {
    // accept [lat, lng] or [lng, lat]
    const [a, b] = x
    if (isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: +a, lng: +b }
    if (isFinite(a) && isFinite(b)) return { lat: +b, lng: +a }
  }
  throw new Error('invalid coordinate: ' + JSON.stringify(x))
}

function getIp(req) {
  const xfwd = req.headers['x-forwarded-for']
  if (typeof xfwd === 'string') return xfwd.split(',')[0].trim()
  if (Array.isArray(xfwd) && xfwd.length) return xfwd[0].split(',')[0].trim()
  return (req.ip || req.connection?.remoteAddress || '').toString()
}

function getDbNameFromUri(uri) {
  try {
    const u = new URL(uri)
    const name = (u.pathname || '').replace(/^\//, '')
    return name || undefined
  } catch {
    return undefined
  }
}

app.listen(PORT, () => console.log(`[api] listening on :${PORT}`))
