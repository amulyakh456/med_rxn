/**
 * Express + Next.js route handlers for the interaction engine.
 *
 * EXPRESS USAGE — in your existing recordrx Express app:
 *
 *   const { Pool } = require('pg');
 *   const { mountInteractionRoutes } = require('./interactions/routes');
 *
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   const requireAuth = require('./middleware/auth');     // your existing auth
 *
 *   mountInteractionRoutes(app, pool, { authMiddleware: requireAuth });
 *
 * Mounts:
 *   GET  /api/interactions/search?q=...
 *   POST /api/interactions/check     body: { brands: [...] }
 *   GET  /api/interactions/health
 *
 * NEXT.JS USAGE — see app/api/interactions/check/route.js example at bottom.
 */

'use strict';

const { InteractionEngine } = require('./interactionEngine');

function mountInteractionRoutes(app, pool, opts = {}) {
  const engine = new InteractionEngine(pool);
  const auth = opts.authMiddleware || ((req, res, next) => next());
  const prefix = opts.prefix || '/api/interactions';

  app.get(`${prefix}/health`, async (req, res) => {
    try {
      const r = await pool.query('SELECT count(*)::int AS c FROM rx.medicines');
      res.json({ status: 'ok', medicines: r.rows[0].c });
    } catch (e) {
      res.status(500).json({ status: 'error', error: String(e) });
    }
  });

  app.get(`${prefix}/search`, auth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    if (q.length < 2) return res.json({ results: [] });

    try {
      const ql = q.toLowerCase();
      const { rows } = await pool.query(
        `
        SELECT brand_name, generic_name, dosage, dosage_form, manufacturer
        FROM rx.medicines
        WHERE brand_family ILIKE $1 || '%'
           OR brand_lc     LIKE  '%' || $2 || '%'
        ORDER BY
          (brand_family LIKE $2 || '%') DESC,
          length(brand_name) ASC
        LIMIT $3
        `,
        [ql, ql, limit]
      );
      res.json({ results: rows });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post(`${prefix}/check`, auth, async (req, res) => {
    const brands = Array.isArray(req.body && req.body.brands) ? req.body.brands : null;
    if (!brands || brands.length < 1) {
      return res.status(400).json({ error: 'Body must be { brands: [...] }' });
    }
    try {
      const result = await engine.check(brands);
      res.json(result);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  return engine;
}

module.exports = { mountInteractionRoutes };

/* -----------------------------------------------------------------------------
 NEXT.JS APP-ROUTER variant — drop these into recordrx if it uses Next.js:

 // app/api/interactions/check/route.js
 import { NextResponse } from 'next/server';
 import { Pool } from 'pg';
 import { InteractionEngine } from '@/lib/interactions/interactionEngine';
 import { requireAuth } from '@/lib/auth';      // your existing auth

 const pool = global._rxPool || new Pool({ connectionString: process.env.DATABASE_URL });
 if (process.env.NODE_ENV !== 'production') global._rxPool = pool;
 const engine = new InteractionEngine(pool);

 export async function POST(req) {
   await requireAuth(req);
   const { brands } = await req.json();
   const result = await engine.check(brands || []);
   return NextResponse.json(result);
 }

 // app/api/interactions/search/route.js
 export async function GET(req) {
   await requireAuth(req);
   const url = new URL(req.url);
   const q = (url.searchParams.get('q') || '').trim();
   if (q.length < 2) return NextResponse.json({ results: [] });
   const ql = q.toLowerCase();
   const { rows } = await pool.query(
     `SELECT brand_name, generic_name, dosage, dosage_form, manufacturer
        FROM rx.medicines
        WHERE brand_family ILIKE $1 || '%' OR brand_lc LIKE '%' || $1 || '%'
        ORDER BY (brand_family LIKE $1 || '%') DESC, length(brand_name) ASC
        LIMIT 10`,
     [ql]
   );
   return NextResponse.json({ results: rows });
 }
----------------------------------------------------------------------------- */
