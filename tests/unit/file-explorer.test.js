import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRelativeDirectory, resolvePermittedDirectory, listExplorerRoots, listExplorerDirectory } from "../../src/modules/system/file-explorer.service.js";

const root = { id: "folder-1", path: "", label: "Teste" };
test("nega caminhos absolutos, traversal e arquivos sensíveis", () => {
  for (const invalid of ["/etc", "../etc", "a/../../b", "./a", "a//b", ".env", "logs/.secret", "a\\b", "secret-data", "a/private_key", "a\0b", "a/"]) {
    assert.throws(() => validateRelativeDirectory(invalid), { code: "FILES_PATH_DENIED" }, invalid);
  }
  assert.equal(validateRelativeDirectory("apps/public/videos"), "apps/public/videos");
});

test("explorador calcula tamanhos, oculta segredos e rejeita symlinks", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "deltatv-fileexplorer-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "deltatv-fileexplorer-outside-"));
  try {
    root.path = folder;
    const roots = [root];
    await fs.mkdir(path.join(folder, "public"));
    await fs.writeFile(path.join(folder, "public", "video.mp4"), Buffer.alloc(1024));
    await fs.writeFile(path.join(folder, ".env"), "DB_PASSWORD=test");
    await fs.writeFile(path.join(folder, "secret-token.txt"), "hidden");
    await fs.symlink(outside, path.join(folder, "external"));
    const result = await listExplorerDirectory({ rootId: root.id, roots });
    assert.equal(result.entries.some((e) => e.name === "public"), true);
    assert.equal(result.entries.some((e) => e.name === ".env"), false);
    assert.equal(result.entries.some((e) => e.name === "secret-token.txt"), false);
    assert.equal(result.entries.some((e) => e.name === "external"), false);
    assert.ok(BigInt(result.entries.find((e) => e.name === "public").bytes) >= 1024n);
    const sub = await resolvePermittedDirectory(root.id, "public", roots);
    assert.equal(sub.relative, "public");
    await assert.rejects(resolvePermittedDirectory(root.id, "external", roots), { code: "FILES_PATH_DENIED" });
    const volumes = await listExplorerRoots(roots);
    assert.equal(volumes.roots[0].available, true);
    assert.ok(BigInt(volumes.roots[0].disk.totalBytes) > 0n);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
