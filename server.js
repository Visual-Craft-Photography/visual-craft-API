// server.js (CommonJS)
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// 1) STATIC FILES – put this BEFORE any catch-all
// Serve everything from the repo root
app.use(express.static(process.cwd(), { extensions: ['html'] }));
// (Optional explicit mounts if you prefer)
// app.use('/images', express.static(path.join(process.cwd(), 'images')));
// app.use('/icons', express.static(path.join(process.cwd(), 'icons')));

// 2) API ENDPOINTS (examples; keep your real ones here)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ... your other /api routes (availability, book, etc.) ...

// 3) SPA FALLBACK – must be LAST and must exclude /api
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

app.listen(PORT, () => {
  console.log(`VC backend + SPA listening on ${PORT}`);
});
