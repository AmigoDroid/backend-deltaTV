import { Op } from "sequelize";
import { AppDownload } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { pageOf, paged } from "../../shared/pagination.js";
import * as storage from "./download.storage.js";

/**
 * Downloads e links: o admin cadastra (aplicativo: nome, versão, link, código do Downloader; ou link comum) e os
 * revendedores só consultam. Um aplicativo pode apontar para um link externo OU para um APK hospedado na própria VPS.
 */
const present = (d) => ({
  id: d.id, kind: d.kind, name: d.name, version: d.version ?? null, downloadUrl: d.downloadUrl,
  downloaderCode: d.downloaderCode ?? null, hosted: !!d.fileName, fileSize: d.fileSize != null ? Number(d.fileSize) : null,
  createdAt: d.createdAt, updatedAt: d.updatedAt,
});

export async function listDownloads({ q, kind, page, pageSize }) {
  const where = {};
  if (kind) where.kind = kind;
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, "")}%`;
    where[Op.or] = [{ name: { [Op.iLike]: like } }, { version: { [Op.iLike]: like } }];
  }
  const { rows, count } = await AppDownload.findAndCountAll({
    where, order: [["name", "ASC"], ["createdAt", "DESC"]], ...pageOf({ page, pageSize }),
  });
  return paged(rows.map(present), count, { page, pageSize });
}

// Link comum não tem versão nem código do Downloader: nunca grava esses campos.
const forKind = (input, kind) => (kind === "link" ? { ...input, version: null, downloaderCode: null } : input);

// Confere que o arquivo enviado existe em disco e que nenhum outro item já usa ele.
async function claimFile(fileId, exceptId) {
  const st = await storage.statFile(fileId);
  if (!st) throw new AppError(400, "FILE_NOT_FOUND", "O arquivo enviado não foi encontrado. Envie novamente.");
  const taken = await AppDownload.findOne({ where: { fileName: storage.fileNameOf(fileId), ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) } });
  if (taken) throw new AppError(409, "FILE_IN_USE", "Este arquivo já está vinculado a outro item.");
  return { fileName: storage.fileNameOf(fileId), fileSize: st.size };
}

export async function createDownload(input, actor) {
  const { fileId, ...rest } = input;
  let data = forKind(rest, rest.kind);
  if (fileId && rest.kind !== "link") {
    const f = await claimFile(fileId);
    data = { ...data, ...f, downloadUrl: storage.urlFor(fileId, `${rest.name} ${rest.version || ""}`) };
  }
  const d = await AppDownload.create({ ...data, createdBy: actor?.id ?? null });
  await audit({ actor, action: "app_download.create", entityType: "app_download", entityId: d.id, metadata: { name: d.name, version: d.version, hosted: !!d.fileName } });
  return present(d);
}

export async function updateDownload(id, input, actor) {
  const d = await AppDownload.findByPk(id);
  if (!d) throw notFound("Download");
  const { fileId, ...rest } = input;
  const kind = rest.kind ?? d.kind;
  let data = forKind(rest, kind);
  let removeOld = null;

  if (kind === "link") {
    // Link comum nunca guarda arquivo.
    if (d.fileName) { removeOld = d.fileName; data = { ...data, fileName: null, fileSize: null }; }
  } else if (fileId) {
    // Arquivo novo enviado: substitui o anterior (se havia) e o link passa a ser o da VPS.
    const f = await claimFile(fileId, d.id);
    data = { ...data, ...f, downloadUrl: storage.urlFor(fileId, `${rest.name ?? d.name} ${(rest.version !== undefined ? rest.version : d.version) || ""}`) };
    if (d.fileName && d.fileName !== f.fileName) removeOld = d.fileName;
  } else if (d.fileName && (fileId === null || (rest.downloadUrl !== undefined && rest.downloadUrl !== d.downloadUrl))) {
    // Voltou a usar link externo: o arquivo da VPS deixa de existir.
    removeOld = d.fileName;
    data = { ...data, fileName: null, fileSize: null };
  }

  await d.update(data);
  if (removeOld) await storage.removeFile(removeOld);
  await audit({ actor, action: "app_download.update", entityType: "app_download", entityId: d.id, metadata: { name: d.name, version: d.version, hosted: !!d.fileName } });
  return present(d);
}

export async function deleteDownload(id, actor) {
  const d = await AppDownload.findByPk(id);
  if (!d) throw notFound("Download");
  await d.destroy();
  if (d.fileName) await storage.removeFile(d.fileName);
  await audit({ actor, action: "app_download.delete", entityType: "app_download", entityId: id, metadata: { name: d.name } });
}

/** Recebe o APK (corpo cru da requisição) e guarda em disco. O arquivo só "pertence" a um item quando o item é salvo. */
export async function uploadFile(req, filename, actor) {
  const { id, size } = await storage.saveUpload(req);
  await audit({ actor, action: "app_download.upload", entityType: "app_download", entityId: null, metadata: { filename, size } });
  // Limpeza oportunista de arquivos soltos (envios nunca salvos); não atrasa nem derruba a resposta.
  AppDownload.findAll({ attributes: ["fileName"], where: { fileName: { [Op.ne]: null } }, raw: true })
    .then((rows) => storage.sweepOrphans(new Set(rows.map((r) => r.fileName)))).catch(() => {});
  return { fileId: id, size, downloadUrl: storage.urlFor(id, filename) };
}

/** Descarta um envio que ainda não foi salvo num item (ex.: o admin fechou o formulário). Nunca apaga arquivo em uso. */
export async function discardUpload(fileId) {
  if (!storage.ID_RE.test(fileId)) return;
  const used = await AppDownload.findOne({ where: { fileName: storage.fileNameOf(fileId) } });
  if (!used) await storage.removeFile(fileId);
}
