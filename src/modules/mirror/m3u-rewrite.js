import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Reescreve, em fluxo (sem carregar a lista inteira na memória), as URLs de mídia de uma playlist M3U do painel
 * para a rota espelho do servidor:
 *   http://painel:8080/live/USER/PASS/123.ts      ->  <base>/live/<mirrorUser>/<mirrorPass>/123.ts
 *   http://painel:8080/movie/USER/PASS/9.mp4      ->  <base>/movie/<mirrorUser>/<mirrorPass>/9.mp4
 *   http://painel:8080/USER/PASS/123              ->  <base>/<mirrorUser>/<mirrorPass>/123   (canal ao vivo, formato curto)
 * Vale para qualquer host cuja URL carregue a credencial real (o stream pode ficar em outro servidor do painel).
 * Qualquer outra linha (#EXTINF, logos, URLs sem a credencial) passa intacta.
 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function m3uMirrorRewriter({ username, password, base, mirrorUser, mirrorPass }) {
  const u = `(?:${esc(username)}|${esc(encodeURIComponent(username))})`;
  const p = `(?:${esc(password)}|${esc(encodeURIComponent(password))})`;
  const re = new RegExp(`^https?://[^/\\s]+/(?:(live|movie|series)/)?${u}/${p}/([^/\\s?]+)(\\?.*)?$`, "i");
  const out = base.replace(/\/+$/, "");
  const fix = (line) => {
    const t = line.trimEnd();
    if (!t || t.startsWith("#")) return line;
    const m = t.match(re);
    if (!m) return line;
    const kind = m[1] ? `/${m[1].toLowerCase()}` : "";
    return `${out}${kind}/${encodeURIComponent(mirrorUser)}/${encodeURIComponent(mirrorPass)}/${m[2]}${m[3] ?? ""}`;
  };

  let rest = "";
  const dec = new StringDecoder("utf8");
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = rest + dec.write(chunk);
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      cb(null, lines.length ? lines.map(fix).join("\n") + "\n" : "");
    },
    flush(cb) {
      rest += dec.end();
      cb(null, rest ? fix(rest) : "");
    },
  });
}
