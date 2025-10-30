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

// --- Lógica Playwright ---
async function pairDevice({ otp, label }) {
  const email = process.env.NANOMID_EMAIL;
  const password = process.env.NANOMID_PASSWORD;
  if (!email || !password) return { ok: false, error: 'Configura NANOMID_EMAIL y NANOMID_PASSWORD' };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1) Login
    await page.goto('https://nanomid.com/es/login', { waitUntil: 'domcontentloaded' });

    // 👇 AJUSTA estos selectores según la UI real (usa getByLabel / getByPlaceholder / getByRole / locator):
    await page.getByLabel(/correo|email/i).fill(email);
    await page.getByLabel(/contraseña|password/i).fill(password);
    await page.getByRole('button', { name: /iniciar sesión|entrar|login/i }).click();

    await page.waitForURL(/dashboard|panel|account/i, { timeout: 20000 });

    // 2) Ir a Devices
    await page.goto('https://nanomid.com/es/dashboard/player/devices', { waitUntil: 'domcontentloaded' });

    // 3) Completar OTP y nombre
    await page.getByLabel(/otp|quickcode|c[oó]digo/i).fill(otp);
    await page.getByLabel(/nombre|etiqueta|pedido|label/i).fill(label);
    await page.getByRole('button', { name: /sincronizar|vincular|pair|add|añadir/i }).click();

    // 4) Confirmación: busca toast o fila nueva en lista
    await page.waitForTimeout(1200);
    const okToast = await page.locator('text=/Añadido|Sincronizado|Emparejado|Added|Paired/i').first().isVisible().catch(() => false);
    const hasError = await page.locator('text=/inv[aá]lido|error|no v[aá]lido|failed/i').first().isVisible().catch(() => false);

    await browser.close();
    if (okToast && !hasError) return { ok: true };
    return { ok: false, error: 'No se confirmó el emparejado en la UI.' };
  } catch (e) {
    await browser.close();
    return { ok: false, error: e.message };
  }
}
