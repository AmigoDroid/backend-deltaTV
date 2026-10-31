import { Op } from "sequelize";
import { AppDownload } from "../../db/models/index.js";
import { notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { pageOf, paged } from "../../shared/pagination.js";

/**
 * Downloads de aplicativos: o admin cadastra (nome, versão, link, código do Downloader) e os revendedores só consultam.
 */
const present = (d) => ({
  id: d.id, kind: d.kind, name: d.name, version: d.version ?? null, downloadUrl: d.downloadUrl,
  downloaderCode: d.downloaderCode ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt,
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

export async function createDownload(input, actor) {
  const d = await AppDownload.create({ ...forKind(input, input.kind), createdBy: actor?.id ?? null });
  await audit({ actor, action: "app_download.create", entityType: "app_download", entityId: d.id, metadata: { name: d.name, version: d.version } });
  return present(d);
}

export async function updateDownload(id, input, actor) {
  const d = await AppDownload.findByPk(id);
  if (!d) throw notFound("Download");
  await d.update(forKind(input, input.kind ?? d.kind));
  await audit({ actor, action: "app_download.update", entityType: "app_download", entityId: d.id, metadata: { name: d.name, version: d.version } });
  return present(d);
}

export async function deleteDownload(id, actor) {
  const d = await AppDownload.findByPk(id);
  if (!d) throw notFound("Download");
  await d.destroy();
  await audit({ actor, action: "app_download.delete", entityType: "app_download", entityId: id, metadata: { name: d.name } });
}
