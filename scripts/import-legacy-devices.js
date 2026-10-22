/**
 * Importa o antigo devices.json para o novo modelo.
 *   node scripts/import-legacy-devices.js caminho/devices.json [--months 12]
 * - Cria 1 licença individual (1 dispositivo) por MAC, com ativação pendente de "claim"
 *   (o app antigo fixa o installationId na primeira chamada a /api/v1/client/claim).
 * - Fontes legadas entram em modo "proxy": o player web antigo depende dele (CORS e URL com credenciais).
 *   Troque para "redirect" quando a origem enviar CORS/URLs assinadas.
 * - A URL da playlist (com usuário/senha) é gravada CIFRADA em content_sources (escopo global);
 *   nada é copiado em texto puro. Dispositivos "suspended" entram como licença suspensa.
 * - Os códigos de licença gerados são impressos UMA vez no terminal.
 */
import fs from "node:fs";
import { sequelize, Plan, License, Device, Activation, ContentSource } from "../src/db/models/index.js";
import { normalizeMac } from "../src/shared/mac.js";
import { generateCode, hashCode, encryptSecret } from "../src/shared/crypto.js";
import { addMonthsUTC } from "../src/shared/dates.js";

const file = process.argv[2];
if (!file) throw new Error("Uso: node scripts/import-legacy-devices.js devices.json [--months 12]");
const months = Number(process.argv[process.argv.indexOf("--months") + 1]) || 12;
const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
const list = Array.isArray(legacy) ? legacy : legacy.devices ?? [];

const plan = await Plan.findOne({ where: { durationMonths: months, active: true } });
if (!plan) throw new Error("Plano não encontrado. Rode `npm run db:seed` antes.");

const sources = new Map(); // url -> source
const report = [];
await sequelize.transaction(async (t) => {
  for (const d of list) {
    const mac = normalizeMac(d.mac);
    if (!mac) { report.push({ mac: d.mac, result: "MAC inválido, ignorado" }); continue; }
    if (await Activation.findOne({ where: { mac }, transaction: t })) { report.push({ mac, result: "já importado" }); continue; }

    if (d.playlistUrl && !sources.has(d.playlistUrl)) {
      const url = new URL(d.playlistUrl);
      sources.set(d.playlistUrl, await ContentSource.create({
        name: `Legado - ${url.hostname}`, kind: "playlist", scope: "global", deliveryMode: "proxy", urlEnc: encryptSecret(url.href), host: url.hostname,
      }, { transaction: t }));
    }
    const code = generateCode("LIC");
    const now = new Date();
    const license = await License.create({
      codeHash: hashCode(code), codeLast4: code.slice(-4), planId: plan.id, maxDevices: 1,
      status: d.status === "suspended" ? "suspended" : "active", statusReason: d.status === "suspended" ? "Importado como suspenso" : null,
      startsAt: now, expiresAt: addMonthsUTC(now, months), notes: "Importado do devices.json",
    }, { transaction: t });
    const [device] = await Device.findOrCreate({ where: { mac }, defaults: { mac }, transaction: t });
    await Activation.create({ deviceId: device.id, mac, licenseId: license.id, claimPending: true }, { transaction: t });
    report.push({ mac, result: "importado", code });
  }
});
console.table(report);
console.log("Guarde os códigos acima: não serão exibidos novamente. TROQUE a senha do provedor IPTV exposta no arquivo antigo.");
await sequelize.close();
