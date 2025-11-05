
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import axios from 'axios'
import { addMinutes, setHours, setMinutes, setSeconds } from 'date-fns'
import { google } from 'googleapis'
import nodemailer from 'nodemailer'
import { createEvent as createICS } from 'ics'
import { nanoid } from 'nanoid'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'

const app = express()
app.use(cors())
app.use(express.json())

const {
  PUBLIC_BASE_URL,
  FRONTEND_BASE_URL,
  BUSINESS_TZ='America/New_York',
  GOOGLE_CALENDAR_ID='primary',
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_IMPERSONATE_EMAIL,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REFRESH_TOKEN,
  GOOGLE_MAPS_API_KEY,
  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS,
  MAIL_FROM_EMAIL, MAIL_FROM_NAME, ADMIN_EMAIL,
  BUSINESS_HOME_ADDR,
  BUSINESS_HOURS='Tue:09:00-17:00,Wed:09:00-17:00,Thu:09:00-17:00,Fri:09:00-17:00',
  MAX_TRAVEL_MILES=60,
  DEFAULT_DRIVE_BUFFER_MIN=20,
  ONE_TAP_SECRET='dev-secret'
} = process.env

const db = new Database('data.sqlite')
db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    code TEXT PRIMARY KEY,
    eventId TEXT NOT NULL,
    pkgKey TEXT,
    pkgMinutes INTEGER,
    type TEXT,
    address TEXT,
    startISO TEXT,
    clientName TEXT,
    clientEmail TEXT,
    createdAt TEXT
  );
`)

const transporter = nodemailer.createTransport({
  host: SMTP_HOST, port: Number(SMTP_PORT || 465), secure: (SMTP_SECURE||'true')==='true',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
})

async function getAuth() {
  if (GOOGLE_SERVICE_ACCOUNT_JSON && GOOGLE_IMPERSONATE_EMAIL) {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)
    const auth = new google.auth.JWT(
      creds.client_email, null, creds.private_key,
      ['https://www.googleapis.com/auth/calendar'], GOOGLE_IMPERSONATE_EMAIL
    )
    await auth.authorize(); return auth
  }
  if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET && GOOGLE_OAUTH_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN })
    return oauth2
  }
  throw new Error('Google auth not configured')
}
async function cal() { return google.calendar({ version:'v3', auth: await getAuth() }) }

function hoursMap(str){
  const m={}; str.split(',').forEach(part=>{
    const [day,times]=part.split(':');
    if(!times) return;
    const [s,e]=times.split('-');
    m[day.trim()]={ start:s.trim(), end:e.trim() }
  }); return m
}
const BIZ = hoursMap(BUSINESS_HOURS)
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function withinBusiness(date){
  const key=DAYS[date.getDay()], rule=BIZ[key]; if(!rule) return false
  const [sh,sm]=rule.start.split(':').map(Number), [eh,em]=rule.end.split(':').map(Number)
  const s=setSeconds(setMinutes(setHours(new Date(date),sh),sm),0)
  const e=setSeconds(setMinutes(setHours(new Date(date),eh),em),0)
  return date>=s && date<e
}

async function driveInfo(origin, destination){
  if(!GOOGLE_MAPS_API_KEY) return { minutes: Number(DEFAULT_DRIVE_BUFFER_MIN), miles: 0 }
  const url='https://maps.googleapis.com/maps/api/distancematrix/json'
  const { data } = await axios.get(url, { params:{
    origins: origin, destinations: destination, key: GOOGLE_MAPS_API_KEY, units:'imperial', departure_time:'now'
  }})
  const leg = data?.rows?.[0]?.elements?.[0]
  if(!leg || leg.status!=='OK') return { minutes: Number(DEFAULT_DRIVE_BUFFER_MIN), miles: 0 }
  const seconds = leg.duration_in_traffic?.value || leg.duration?.value || DEFAULT_DRIVE_BUFFER_MIN*60
  const meters = leg.distance?.value || 0
  const miles = meters/1609.34
  return { minutes: Math.ceil(seconds/60), miles }
}

// Availability with travel-awareness
app.post('/api/availability', async (req,res)=>{
  try{
    const { dateISO, pkgMinutes=60, address } = req.body || {}
    if(!dateISO) return res.status(400).json({ error:'dateISO required' })
    const day=new Date(dateISO)
    const key=DAYS[day.getDay()], rule=BIZ[key]; if(!rule) return res.json({ dateISO, slots: [] })

    const calApi=await cal()
    const timeMin = new Date(day); timeMin.setHours(0,0,0,0)
    const timeMax = new Date(day); timeMax.setHours(23,59,59,999)
    const { data } = await calApi.freebusy.query({
      requestBody:{ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items:[{ id: GOOGLE_CALENDAR_ID }] }
    })
    const busy = data?.calendars?.[GOOGLE_CALENDAR_ID]?.busy || []

    const [sh,sm]=rule.start.split(':').map(Number), [eh,em]=rule.end.split(':').map(Number)
    const startDay = new Date(day); startDay.setHours(sh,sm,0,0)
    const endDay = new Date(day); endDay.setHours(eh,em,0,0)

    const { data: evs } = await calApi.events.list({
      calendarId: GOOGLE_CALENDAR_ID, timeMin: startDay.toISOString(), timeMax: endDay.toISOString(), singleEvents:true, orderBy:'startTime'
    })
    const slots=[]
    for(let t=new Date(startDay); t<endDay; t=new Date(t.getTime()+30*60000)){
      const s=new Date(t), e=addMinutes(s, pkgMinutes); if(e>endDay) continue
      if(!withinBusiness(s) || !withinBusiness(e)) continue
      const overlaps = busy.some(b => !(e <= new Date(b.start) || s >= new Date(b.end)))
      if(overlaps) continue

      // Service area check from base to job
      const baseLeg = await driveInfo(BUSINESS_HOME_ADDR, address || BUSINESS_HOME_ADDR)
      if (baseLeg.miles > Number(MAX_TRAVEL_MILES)) continue

      // Travel time from previous job to this address (if any)
      let ok=true
      const prev = (evs?.items||[]).filter(ev => ev.end?.dateTime && new Date(ev.end.dateTime) <= s).pop()
      if(prev && address){
        const origin = prev.location || BUSINESS_HOME_ADDR
        const travel = await driveInfo(origin, address)
        if(new Date(prev.end.dateTime) > new Date(s.getTime() - travel.minutes*60000)) ok=false
      }
      if(!ok) continue
      slots.push({ start: s.toISOString(), end: e.toISOString(), milesFromBase: baseLeg.miles })
    }
    res.json({ dateISO, slots })
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }) }
})

app.post('/api/book', async (req,res)=>{
  try{
    const { type, pkgKey, pkgMinutes=60, address, startISO, client } = req.body
    const calApi=await cal()
    const endISO = addMinutes(new Date(startISO), pkgMinutes).toISOString()
    const summary = `Visual Craft • ${pkgKey}`
    const description = `Type: ${type}\nAddress: ${address}\nPackage: ${pkgKey}\nClient: ${client?.name||''} ${client?.email||''}`
    const { data: created } = await calApi.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: { summary, description, location: address, start:{dateTime:startISO}, end:{dateTime:endISO}, reminders:{useDefault:true} }
    })
    const code = `VCP-${nanoid(8).toUpperCase()}`
    db.prepare(`INSERT INTO bookings(code,eventId,pkgKey,pkgMinutes,type,address,startISO,clientName,clientEmail,createdAt)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, created.id, pkgKey, pkgMinutes, type, address, startISO, client?.name||'', client?.email||'', new Date().toISOString())

    const ics = await new Promise((resolve,reject)=>{
      createICS({
        start: isoParts(startISO), end: isoParts(endISO),
        title: 'Visual Craft – Session',
        description: `Confirmation ${code}\nManage: ${FRONTEND_BASE_URL}/#/manage/${code}`,
        location: address, organizer:{ name:MAIL_FROM_NAME, email:MAIL_FROM_EMAIL }
      }, (err,val)=> err?reject(err):resolve(val))
    })

    const token = jwt.sign({ code, action:'one_tap_reschedule' }, ONE_TAP_SECRET, { expiresIn:'7d' })
    const oneTapUrl = `${PUBLIC_BASE_URL}/api/one-tap-reschedule?token=${encodeURIComponent(token)}`

    await transporter.sendMail({
      from:{ name:MAIL_FROM_NAME, address:MAIL_FROM_EMAIL },
      to:[client?.email, ADMIN_EMAIL].filter(Boolean),
      subject:`Booking Confirmed • ${code}`,
      html:`<p>Your session is booked.</p>
            <p><strong>Manage:</strong> <a href="${FRONTEND_BASE_URL}/#/manage/${code}">${FRONTEND_BASE_URL}/#/manage/${code}</a></p>
            <p><strong>One‑tap reschedule:</strong> <a href="${oneTapUrl}">Pick the next available time</a>.</p>`,
      text:`Manage: ${FRONTEND_BASE_URL}/#/manage/${code}\nOne-tap reschedule: ${oneTapUrl}`,
      attachments:[{ filename:`${code}.ics`, content: Buffer.from(ics,'utf8'), contentType:'text/calendar' }]
    })

    res.json({ ok:true, code })
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }) }
})

function isoParts(iso){ const d=new Date(iso); return [d.getFullYear(), d.getMonth()+1, d.getDate(), d.getHours(), d.getMinutes()] }

app.get('/api/booking/:code', (req,res)=>{
  const row = db.prepare('SELECT * FROM bookings WHERE code=?').get(req.params.code)
  if(!row) return res.status(404).json({ error:'Not found' })
  res.json(row)
})

app.post('/api/reschedule', async (req,res)=>{
  try{
    const { code, newStartISO } = req.body
    const row = db.prepare('SELECT * FROM bookings WHERE code=?').get(code)
    if(!row) return res.status(404).json({ error:'Not found' })
    const calApi = await cal()
    const newEndISO = addMinutes(new Date(newStartISO), row.pkgMinutes).toISOString()
    await calApi.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.eventId, requestBody:{ start:{dateTime:newStartISO}, end:{dateTime:newEndISO} } })
    db.prepare('UPDATE bookings SET startISO=? WHERE code=?').run(newStartISO, code)
    res.json({ ok:true, code, newStartISO, newEndISO })
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }) }
})

app.post('/api/cancel', async (req,res)=>{
  try{
    const { code } = req.body
    const row = db.prepare('SELECT * FROM bookings WHERE code=?').get(code)
    if(!row) return res.status(404).json({ error:'Not found' })
    const calApi = await cal()
    await calApi.events.delete({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.eventId })
    db.prepare('DELETE FROM bookings WHERE code=?').run(code)
    res.json({ ok:true })
  }catch(e){ console.error(e); res.status(500).json({ error:e.message }) }
})

app.get('/api/one-tap-reschedule', async (req,res)=>{
  try{
    const { token } = req.query
    const payload = jwt.verify(token, ONE_TAP_SECRET)
    if(payload.action!=='one_tap_reschedule') throw new Error('bad action')
    const row = db.prepare('SELECT * FROM bookings WHERE code=?').get(payload.code)
    if(!row) throw new Error('Booking not found')
    const dayISO = new Date().toISOString().slice(0,10)+'T00:00:00'
    const avail = await axios.post(`${PUBLIC_BASE_URL}/api/availability`, { dateISO:dayISO, pkgMinutes:row.pkgMinutes, address:row.address })
    const s = avail.data?.slots?.[0]
    if(!s) return res.status(200).send(`<html><body>No slots today. Manage here: <a href="${FRONTEND_BASE_URL}/#/manage/${row.code}">Manage</a></body></html>`)
    const calApi = await cal()
    await calApi.events.patch({ calendarId: GOOGLE_CALENDAR_ID, eventId: row.eventId, requestBody:{ start:{dateTime:s.start}, end:{dateTime:s.end} } })
    db.prepare('UPDATE bookings SET startISO=? WHERE code=?').run(s.start, row.code)
    res.status(200).send(`<html><body>Rescheduled to ${new Date(s.start).toLocaleString()}. <a href="${FRONTEND_BASE_URL}/#/manage/${row.code}">View</a></body></html>`)
  }catch(e){
    console.error(e); res.status(400).send(`<html><body>Could not reschedule. <a href="${FRONTEND_BASE_URL}/#/manage">Manage booking</a></body></html>`)
  }
})

const PORT = process.env.PORT || 8081
app.listen(PORT, ()=> console.log('VC backend PRO on http://localhost:'+PORT))
