/**
 * Explorador de armazenamento SOMENTE LEITURA para o Superadmin.
 * Nunca fornece conteúdo de arquivos nem aceita caminhos absolutos arbitrários.
 * Cálculos du são sob demanda, cacheados e limitados para proteger a VPS.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { AppError } from "../../shared/errors.js";

const MAX_VISIBLE = 300;
const CACHE_MS = 2 * 60_000;
const DU_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const sizeCache = new Map();
const pending = new Map();
let activeScans = 0;

const reject = (message = "Pasta não permitida.") => {
  throw new AppError(403, "FILES_PATH_DENIED", message);
};

const hiddenOrSensitive = (name) => {
  const lower = name.toLowerCase();
  return name.startsWith(".") || /(?:^|[._-])(secret|credential|password|passwd|private|token|backup-key)(?:[._-]|$)/i.test(lower) ||
    /\.(?:pem|key|p12|pfx|asc|gpg|kdbx)$/i.test(lower);
};

export function validateRelativeDirectory(raw = "") {
  if (typeof raw !== "string" || raw.length > 1024 || raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw)) reject();
  if (!raw) return "";
  const parts = raw.split("/");
  if (parts.some((segment) => !segment || segment === "." || segment === ".." || hiddenOrSensitive(segment))) reject();
  return parts.join("/");
}

// Só diretórios explicitamente autorizados no servidor. Nunca expor /, /etc, /root,
// /var/lib/postgresql ou outros diretórios do sistema. Configurar no .env da VPS.
export function configuredRoots() {
  const configured = process.env.VPS_EXPLORER_ROOTS || "/var/www";
  const selected = configured.split(",").map((v) => v.trim()).filter(Boolean);
  return [...new Set(selected)].filter((value) => path.isAbsolute(value) && path.resolve(value) !== "/").slice(0, 8).map((directory, index) => ({
    id: `folder-${index + 1}`,
    path: path.resolve(directory),
    label: path.resolve(directory),
  }));
}

function allowedRootById(rootId, roots) {
  const root = roots.find((item) => item.id === rootId);
  if (!root) reject("Local de armazenamento inválido.");
  return root;
}

async function rootDirectory(root) {
  try {
    const rootStat = await fs.lstat(root.path);
    if (rootStat.isSymbolicLink()) reject("Raiz configurada como link simbólico.");
    const actual = await fs.realpath(root.path);
    const stat = await fs.stat(actual);
    if (!stat.isDirectory()) reject();
    return actual;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(404, "FILES_ROOT_UNAVAILABLE", "Pasta não disponível ou sem permissão de leitura.");
  }
}

export async function resolvePermittedDirectory(rootId, relative = "", roots = configuredRoots()) {
  const root = allowedRootById(rootId, roots);
  const rel = validateRelativeDirectory(relative);
  const base = await rootDirectory(root);
  let candidate = base;
  try {
    for (const segment of rel ? rel.split("/") : []) {
      candidate = path.join(candidate, segment);
      const stat = await fs.lstat(candidate);
      // Symlinks nunca são seguidos (inclusive links internos); protege contra fuga da raiz.
      if (stat.isSymbolicLink() || !stat.isDirectory()) reject();
    }
    const resolved = await fs.realpath(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) reject();
    return { root, base, full: resolved, relative: rel };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(404, "FILES_DIRECTORY_NOT_FOUND", "Pasta inexistente ou inacessível.");
  }
}

// Saída nula para suportar nomes com quebras de linha; sem shell, sem injeção.
async function readDu(directory) {
  return new Promise((resolve) => {
    let child;
    try {
      // Ubuntu GNU coreutils: du calcula blocos alocados, não bytes lógicos de arquivo.
      child = spawn("nice", ["-n", "15", "du", "-x", "-d", "1", "-B1", "-0", "--", directory], {
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      resolve({ sizes: new Map(), partial: true });
      return;
    }
    const buffers = [];
    let count = 0;
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, DU_TIMEOUT_MS);
    child.stdout.on("data", (data) => {
      count += data.length;
      if (count > MAX_OUTPUT_BYTES) { timedOut = true; child.kill("SIGKILL"); return; }
      buffers.push(data);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {});
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const sizes = new Map();
      for (const record of Buffer.concat(buffers).toString("utf8").split("\0")) {
        const tab = record.indexOf("\t");
        if (tab < 1) continue;
        const value = Number(record.slice(0, tab));
        if (Number.isSafeInteger(value) && value >= 0) sizes.set(record.slice(tab + 1), value);
      }
      resolve({ sizes, partial: timedOut || code !== 0 });
    });
  });
}

async function cachedSizes(directory) {
  const old = sizeCache.get(directory);
  if (old && Date.now() - old.at < CACHE_MS) return old.value;
  if (pending.has(directory)) return pending.get(directory);
  if (activeScans >= 1) return { sizes: new Map(), partial: true, busy: true };
  activeScans++;
  const job = readDu(directory).then((value) => {
    // Não cachear cálculos interrompidos.
    if (!value.partial) sizeCache.set(directory, { value, at: Date.now() });
    if (sizeCache.size > 150) sizeCache.delete(sizeCache.keys().next().value);
    return value;
  }).finally(() => { activeScans--; pending.delete(directory); });
  pending.set(directory, job);
  return job;
}

async function diskInfo(directory) {
  try {
    const v = await fs.statfs(directory, { bigint: true });
    const total = v.blocks * v.bsize;
    const available = v.bavail * v.bsize;
    // Espaço usado global do volume, incluindo a reserva do sistema de arquivos.
    return { totalBytes: String(total), availableBytes: String(available), usedBytes: String(total - v.bfree * v.bsize) };
  } catch { return null; }
}

export async function listExplorerRoots(roots = configuredRoots()) {
  return { roots: await Promise.all(roots.map(async (root) => {
    try {
      const base = await rootDirectory(root);
      return { id: root.id, label: root.label, available: true, disk: await diskInfo(base) };
    } catch { return { id: root.id, label: root.label, available: false, disk: null }; }
  })) };
}

export async function listExplorerDirectory({ rootId, relative = "", roots = configuredRoots() }) {
  const target = await resolvePermittedDirectory(rootId, relative, roots);
  let dirents;
  try { dirents = await fs.readdir(target.full, { withFileTypes: true }); }
  catch { throw new AppError(403, "FILES_READ_DENIED", "Sem permissão para listar esta pasta."); }
  const visible = dirents.filter((item) => !hiddenOrSensitive(item.name) && !item.isSymbolicLink() && (item.isFile() || item.isDirectory()));
  const measurement = await cachedSizes(target.full);
  // Pastas mais pesadas primeiro: ajuda a encontrar rapidamente o uso do disco.
  visible.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) ||
    (Number(measurement.sizes.get(path.join(target.full, b.name)) || 0) - Number(measurement.sizes.get(path.join(target.full, a.name)) || 0)) ||
    a.name.localeCompare(b.name, "pt-BR"));
  const selected = visible.slice(0, MAX_VISIBLE);
  const entries = await Promise.all(selected.map(async (item) => {
    const full = path.join(target.full, item.name);
    let bytes = null;
    try {
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) return null; // corrida com substituição por link
      if (item.isFile()) bytes = String(stat.size);
      else if (measurement.sizes.has(full)) bytes = String(measurement.sizes.get(full));
    } catch { return null; }
    return { name: item.name, type: item.isDirectory() ? "directory" : "file", bytes };
  }));
  return {
    rootId,
    relative: target.relative,
    label: target.root.label,
    entries: entries.filter(Boolean),
    truncated: visible.length > MAX_VISIBLE,
    sizesPartial: measurement.partial,
    scanBusy: Boolean(measurement.busy),
    folderBytes: measurement.sizes.has(target.full) ? String(measurement.sizes.get(target.full)) : null,
    disk: await diskInfo(target.full),
    cacheSeconds: CACHE_MS / 1000,
  };
}
