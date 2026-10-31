import fs from "node:fs";
import { promises as fsp } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";

/**
 * Armazenamento dos APKs enviados pelo admin para a própria VPS.
 *  - Em disco o arquivo se chama <24 hex aleatórios>.apk (nunca o nome enviado): não dá para adivinhar nem sobrescrever.
 *  - O link público é  <PUBLIC_BASE_URL>/dl/<id>/<nome-legivel>.apk  (o nome legível só enfeita o download).
 *  - Configuração (opcional):  DOWNLOADS_DIR  (padrão: <backend>/storage/downloads)  e  DOWNLOAD_MAX_MB  (padrão: 500).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const downloadsDir = path.resolve(process.env.DOWNLOADS_DIR || path.join(here, "../../../storage/downloads"));
export const maxBytes = (Number.parseInt(process.env.DOWNLOAD_MAX_MB ?? "", 10) || 500) * 1024 * 1024;
export const maxMb = Math.round(maxBytes / 1024 / 1024);

export const ID_RE = /^[a-f0-9]{24}$/;
export const fileNameOf = (id) => `${id}.apk`;
const pathOf = (id) => path.join(downloadsDir, fileNameOf(id));

export function slugify(text, fallback = "app") {
  const s = String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\.apk$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || fallback;
}
export const urlFor = (id, label) => `${env.publicBaseUrl}/dl/${id}/${slugify(label)}.apk`;

export async function statFile(id) {
  if (!ID_RE.test(id)) return null;
  try { const st = await fsp.stat(pathOf(id)); return st.isFile() ? { size: st.size } : null; } catch { return null; }
}
export async function removeFile(idOrName) {
  const id = String(idOrName ?? "").replace(/\.apk$/, "");
  if (!ID_RE.test(id)) return;
  await fsp.unlink(pathOf(id)).catch(() => {});
}

const tooLarge = () => new AppError(413, "FILE_TOO_LARGE", `O arquivo passa do limite de ${maxMb} MB.`);

/**
 * Recebe o corpo da requisição (bytes crus do APK) direto para o disco, sem carregar na memória.
 * Confere o limite de tamanho e a assinatura de ZIP (todo APK é um ZIP: começa com "PK\x03\x04").
 */
export async function saveUpload(req) {
  await fsp.mkdir(downloadsDir, { recursive: true, mode: 0o750 });
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const id = crypto.randomBytes(12).toString("hex");
  const part = `${pathOf(id)}.part`;
  let size = 0; let head = Buffer.alloc(0); let checked = false;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(tooLarge());
      if (!checked) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 4) {
          checked = true;
          if (head.readUInt32BE(0) !== 0x504b0304) return cb(new AppError(400, "INVALID_FILE", "O arquivo enviado não parece ser um APK válido."));
        }
      }
      return cb(null, chunk);
    },
  });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part, { flags: "wx", mode: 0o640 });
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.unpipe(guard); guard.destroy(); out.destroy();
      fsp.unlink(part).catch(() => {});
      reject(err);
    };
    guard.on("error", fail);
    out.on("error", fail);
    // Conexão caiu antes de terminar o envio.
    req.on("close", () => { if (!req.complete) fail(new AppError(400, "UPLOAD_ABORTED", "O envio foi interrompido.")); });
    out.on("finish", () => { if (!done) { done = true; resolve(); } });
    req.pipe(guard).pipe(out);
  });

  if (size < 4 || !checked) {
    await fsp.unlink(part).catch(() => {});
    throw new AppError(400, "INVALID_FILE", "O arquivo enviado está vazio ou não é um APK válido.");
  }
  await fsp.rename(part, pathOf(id));
  return { id, size };
}

/** Apaga arquivos soltos: envios que nunca foram salvos num item (mais de 24 h) e restos de envios interrompidos (mais de 1 h). */
export async function sweepOrphans(referencedNames) {
  let names;
  try { names = await fsp.readdir(downloadsDir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const isPart = /^[a-f0-9]{24}\.apk\.part$/.test(name);
    if (!isPart && !/^[a-f0-9]{24}\.apk$/.test(name)) continue;
    if (!isPart && referencedNames.has(name)) continue;
    try {
      const st = await fsp.stat(path.join(downloadsDir, name));
      if (now - st.mtimeMs > (isPart ? 3_600_000 : 86_400_000)) await fsp.unlink(path.join(downloadsDir, name));
    } catch { /* já sumiu */ }
  }
}

/** Rota pública do arquivo: GET /dl/:id/:nome.apk. Suporta retomada (Range) e sempre baixa como anexo. */
export function serve(req, res, next) {
  const { id, name } = req.params;
  if (!ID_RE.test(id)) return next();
  res.set({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${slugify(name)}.apk"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=3600",
  });
  res.sendFile(fileNameOf(id), { root: downloadsDir, dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) next(new AppError(404, "NOT_FOUND", "Arquivo não encontrado."));
  });
}
