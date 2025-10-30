import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { chromium } from '@playwright/test';

const app = express();
app.use(express.json());
app.use(helmet());

// ⚠️ Cuando tengas tu dominio del frontend (GitHub Pages), cámbialo aquí:
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || true; // true = permitir todos (temporal)
app.use(cors({ origin: FRONTEND_ORIGIN }));

// Rate limiting básico
const limiter = new RateLimiterMemory({ points: 5, duration: 60 });
app.use(async (req, res, next) => {
  try { await limiter.consume(req.ip); next(); }
  catch { res.status(429).json({ error: 'Demasiados intentos, prueba en 1 min.' }); }
});

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// Endpoint principal
app.post('/api/pair', async (req, res) => {
  try {
    const { otp, label } = req.body || {};
    if (!otp || !label) {
      return res.status(400).json({ error: 'otp y label son obligatorios.' });
    }

    const result = await pairDevice({ otp: String(otp).trim(), label: String(label).trim() });
    if (result.ok) return res.json({ ok: true });
    return res.status(400).json({ error: result.error || 'Fallo al sincronizar.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Servidor escuchando en ' + PORT));

/* ============================
   Utilidades de selección robustas
   ============================ */
async function fillRobusto(page, value, { labels = [], placeholders = [], css = [] } = {}) {
  // 1) Labels
  for (const l of labels) {
    const el = page.getByLabel(l, { exact: false });
    if (await el.count().then(n => n > 0)) { await el.first().fill(value); return true; }
  }
  // 2) Placeholders
  for (const p of placeholders) {
    const el = page.getByPlaceholder(p, { exact: false });
    if (await el.count().then(n => n > 0)) { await el.first().fill(value); return true; }
  }
  // 3) CSS
  for (const c of css) {
    const el = page.locator(c);
    if (await el.count().then(n => n > 0)) { await el.first().fill(value); return true; }
  }
  return false;
}

async function clickRobusto(page, { names = [], roles = ['button'], css = [] } = {}) {
  // 1) Roles + names
  for (const r of roles) {
    for (const n of names) {
      const el = page.getByRole(r, { name: n, exact: false });
      if (await el.count().then(n => n > 0)) { await el.first().click(); return true; }
    }
  }
  // 2) CSS
  for (const c of css) {
    const el = page.locator(c);
    if (await el.count().then(n => n > 0)) { await el.first().click(); return true; }
  }
  return false;
}

/* ============================
   Lógica Playwright
   ============================ */
async function pairDevice({ otp, label }) {
  const email = process.env.NANOMID_EMAIL;
  const password = process.env.NANOMID_PASSWORD;
  if (!email || !password) return { ok: false, error: 'Configura NANOMID_EMAIL y NANOMID_PASSWORD' };

  // Args útiles para Render/hosting
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    /* 1) Login — usando TUS selectores de Selenium (fiables en tu entorno)
       URL y selectores exactos que ya te funcionan:
       - input[name="email"], input[name="password"], botón por texto "Log in"
    */
    await page.goto('https://nanomid.com/en/login', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('//button[contains(text(), "Log in")]').click();

    // Espera a entrar en el dashboard (equivalente a url_contains('/dashboard') en Selenium)
    await page.waitForURL(/\/dashboard/i, { timeout: 20000 });

    /* 2) Ir a Devices (mantengo /en para coherencia con el login) */
    await page.goto('https://nanomid.com/en/dashboard/player/devices', { waitUntil: 'domcontentloaded' });

    /* 3) Completar OTP y Nombre (selectores robustos; ajusta si tienes data-testid específicos) */
    const okOtp = await fillRobusto(page, otp, {
      labels: [/otp/i, /quickcode/i, /code/i, /c[oó]digo/i],
      placeholders: [/otp/i, /quickcode/i, /c[oó]digo/i],
      css: ['input[name*="otp" i]', 'input[placeholder*="otp" i]', '[data-testid*="otp" i]']
    });
    if (!okOtp) throw new Error('No encontré el campo OTP / Quickcode');

    const okLabel = await fillRobusto(page, label, {
      labels: [/name/i, /label/i, /nombre/i, /pedido/i],
      placeholders: [/name/i, /label/i, /nombre/i, /pedido/i],
      css: ['input[name*="name" i]', 'input[name*="label" i]', 'input[placeholder*="name" i]', 'input[placeholder*="nombre" i]']
    });
    if (!okLabel) throw new Error('No encontré el campo Nombre / Nº pedido');

    const okSyncBtn = await clickRobusto(page, {
      names: [/sync/i, /pair/i, /add/i, /link/i, /sincronizar/i, /vincular/i, /a[nñ]adir/i],
      roles: ['button'],
      css: ['button[type="submit"]', '[data-testid*="pair" i]', '[data-testid*="add" i]']
    });
    if (!okSyncBtn) throw new Error('No encontré el botón de sincronizar');

    /* 4) Confirmación visual (toast o similar) */
    await page.waitForTimeout(1500);
    const okToast = await page.locator('text=/Added|Paired|Linked|Sincronizado|Emparejado|Añadido/i').first()
      .isVisible().catch(() => false);
    const hasError = await page.locator('text=/Invalid|inv[aá]lido|Error|Failed|no v[aá]lido/i').first()
      .isVisible().catch(() => false);

    await browser.close();
    if (okToast && !hasError) return { ok: true };
    return { ok: false, error: 'No se confirmó el emparejado en la UI.' };
  } catch (e) {
    // (Opcional) Dejar captura local para diagnóstico
    try { await page.screenshot({ path: 'last-error.png', fullPage: true }); } catch {}
    await browser.close();
    return { ok: false, error: e.message };
  }
}
