// server.js — simple “works-out-of-the-box” build
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// 1) Serve static files from repo root (this must come first)
app.use(express.static(process.cwd(), { extensions: ['html'] }));

// 2) Minimal API so the UI works today

// health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// availability (stub): returns 6 time slots today starting at 9:00am, spacing 90m
app.post('/api/availability', (req, res) => {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0);
  const slots = [];
  const durationMin = 60; // default; UI will show the package minutes anyway
  for (let i = 0; i < 6; i++) {
    const d = new Date(base.getTime() + i * 90 * 60000);
    // future-only slots
    if (d.getTime() > now.getTime() + 15 * 60000) {
      slots.push(d.toISOString());
    }
  }
  res.json({ slots, durationMin });
});

// book (stub): returns a confirmation code; (no email/calendar here to keep it simple)
app.post('/api/book', (req, res) => {
  const s4 = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const code = `VCP-${ymd}-${s4()}`;
  res.json({ ok: true, code });
});

// 3) SPA fallback (must be last; excludes /api)
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

app.listen(PORT, () => {
  console.log(`VC backend + SPA listening on ${PORT}`);
});
