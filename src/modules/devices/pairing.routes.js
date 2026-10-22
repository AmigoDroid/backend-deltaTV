import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { validate } from "../../shared/validate.js";
import { pairingResolveLimiter } from "../../middleware/security.js";
import { resolvePairing } from "./registration.service.js";
import { pairPageHtml } from "./pair-page.js";

const router = Router();
const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

// Página do QR: só exibe o MAC e o botão de copiar. Sem formulário, sem credenciais, sem privilégios.
router.get("/", (_req, res) => {
  res.set({
    ...noStore,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.type("html").send(pairPageHtml({ panelUrl: env.panelUrl }));
});

// O MAC vem do servidor (a partir do token do QR), nunca da URL. O token tem fonte criptográfica e expira.
router.post(
  "/resolve",
  pairingResolveLimiter,
  validate({ body: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/) }) }),
  async (req, res) => {
    res.set(noStore);
    res.json(await resolvePairing(req.valid.body.token));
  },
);

export default router;
