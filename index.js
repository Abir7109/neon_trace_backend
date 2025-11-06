import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import axios from 'axios'
import { MongoClient } from 'mongodb'
import crypto from 'crypto'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())
app.set('trust proxy', true)

const PORT = process.env.PORT || 3001
const ORS_KEY = process.env.ORS_API_KEY
const MONGO_URI = process.env.MONGODB_URI
const FCM_KEY = process.env.FCM_SERVER_KEY || process.env.FCM_KEY || null

let db = null
let memLogs = []
let memDevices = new Map()
let memLocs = []
let memTokens = new Map() // token -> { deviceId, platform, createdAt, updatedAt }

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

// Admin: push register token
app.post('/api/push/register', async (req, res) => {
  try {
    const { deviceId, token, platform = 'android' } = req.body || {}
    if (!deviceId || !token) return res.status(400).json({ error: 'deviceId and token required' })
    const doc = { deviceId: String(deviceId), token: String(token), platform: String(platform), updatedAt: new Date() }
    if (db) {
      await db.collection('push_tokens').updateOne({ token: doc.token }, { $set: doc, $setOnInsert: { createdAt: new Date() } }, { upsert: true })
    } else {
      const prev = memTokens.get(doc.token)
      memTokens.set(doc.token, prev ? { ...prev, ...doc } : { ...doc, createdAt: new Date() })
    }
    return res.json({ ok: true })
  } catch (e) { return res.status(500).json({ error: e.message }) }
})

// Admin: push broadcast
app.post('/api/push/broadcast', async (req, res) => {
  try {
    const { title, body, data } = req.body || {}
    const payloadBase = { notification: { title: String(title||'Neon Trace'), body: String(body||'') }, data: data && typeof data === 'object' ? data : undefined }
    let tokens = []
    if (db) {
      tokens = (await db.collection('push_tokens').find({}).project({ token:1, _id:0 }).toArray()).map((x)=>x.token)
    } else {
      tokens = Array.from(memTokens.keys())
    }
    let sent = 0, failed = 0

    const saJson = process.env.FCM_SERVICE_ACCOUNT
    const projectId = process.env.FCM_PROJECT_ID || (()=>{ try { return JSON.parse(saJson||'{}').project_id } catch { return null } })()

    if (saJson && projectId) {
      // Use FCM HTTP v1 with OAuth2
      const bearer = await getFcmAccessToken()
      const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
      // send with small concurrency
      const maxC = 10
      let inflight = []
      for (const t of tokens) {
        const p = axios.post(url, { message: { token: t, ...payloadBase } }, { headers: { Authorization: `Bearer ${bearer}`, 'Content-Type':'application/json' }, timeout: 20000 })
          .then(()=>{ sent += 1 }).catch(()=>{ failed += 1 })
        inflight.push(p)
        if (inflight.length >= maxC) { await Promise.all(inflight); inflight = [] }
      }
      if (inflight.length) await Promise.all(inflight)
    } else if (FCM_KEY) {
      // Fallback to legacy if configured
      for (let i=0; i<tokens.length; i+=900) {
        const batch = tokens.slice(i, i+900)
        const resp = await axios.post('https://fcm.googleapis.com/fcm/send', { ...payloadBase, registration_ids: batch }, { headers: { 'Content-Type': 'application/json', Authorization: `key=${FCM_KEY}` }, timeout: 20000 }).catch((e)=>({ data: { failure: batch.length, success: 0, error: e.message } }))
        const r = resp.data || {}
        sent += Number(r.success||0); failed += Number(r.failure||0)
      }
    } else {
      return res.status(500).json({ error: 'server_missing_fcm_credentials' })
    }

    return res.json({ ok: true, sent, failed, total: tokens.length })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
})

// Admin: quick stats
app.get('/api/stats', async (req, res) => {
  try {
    if (db) {
      const [devices, locations, logs, tokens] = await Promise.all([
        db.collection('devices').countDocuments({}),
        db.collection('device_locations').countDocuments({}),
        db.collection('route_logs').countDocuments({}),
        db.collection('push_tokens').countDocuments({}),
      ])
      return res.json({ counts: { devices, locations, logs, tokens } })
    } else {
      return res.json({ counts: { devices: memDevices.size, locations: memLocs.length, logs: memLogs.length, tokens: memTokens.size } })
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

// ===== FCM v1 auth helper =====
let _fcmAuth = { token: null, exp: 0 }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_') }
async function getFcmAccessToken() {
  const saStr = process.env.FCM_SERVICE_ACCOUNT
  if (!saStr) throw new Error('missing_service_account')
  let sa
  try { sa = JSON.parse(saStr) } catch { throw new Error('invalid_service_account_json') }
  const now = Math.floor(Date.now()/1000)
  if (_fcmAuth.token && (_fcmAuth.exp - 60*5) > (now*1000)) return _fcmAuth.token
  const header = b64url(JSON.stringify({ alg:'RS256', typ:'JWT' }))
  const payload = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const toSign = `${header}.${payload}`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(toSign)
  sign.end()
  const sig = b64url(sign.sign(sa.private_key))
  const assertion = `${toSign}.${sig}`
  const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  const resp = await axios.post('https://oauth2.googleapis.com/token', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 })
  const { access_token, expires_in } = resp.data || {}
  if (!access_token) throw new Error('token_exchange_failed')
  _fcmAuth = { token: access_token, exp: Date.now() + ((expires_in||3600)*1000) }
  return access_token
}

app.listen(PORT, () => console.log(`[api] listening on :${PORT}`))
