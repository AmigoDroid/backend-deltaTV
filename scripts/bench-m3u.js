// Uso: node scripts/bench-m3u.js <stream|legacy> <nItens>
// Gera uma playlist sintética (grupos/canais/filmes/séries) e mede tempo e memória.
import M3UService from "../src/modules/sources/m3u.service.js";
import { parseM3UStream } from "../src/modules/catalog/m3u-stream.js";

const [mode = "stream", nArg = "300000"] = process.argv.slice(2);
const N = Number(nArg);

function entry(i) {
  const k = i % 10;
  if (k < 5) return [`#EXTINF:-1 tvg-id="c${i % 997}" tvg-name="Canal ${i} HD" tvg-logo="http://logos.example/c/${i}.png" group-title="CANAIS | GRUPO ${i % 120}",Canal ${i} HD`, `http://prov.example:8080/live/usuario/senha/${i}.ts`];
  if (k < 8) return [`#EXTINF:-1 tvg-id="" tvg-name="Filme ${i} (2020)" tvg-logo="http://logos.example/m/${i}.jpg" group-title="FILMES | CATEGORIA ${i % 40}",Filme ${i} (2020)`, `http://prov.example:8080/movie/usuario/senha/${i}.mp4`];
  const s = Math.floor(i / 10) % 500, ep = (i % 20) + 1;
  return [`#EXTINF:-1 tvg-id="" tvg-name="Serie ${s} S01E${String(ep).padStart(2, "0")}" tvg-logo="http://logos.example/s/${s}.jpg" group-title="SÉRIES | GENERO ${s % 15}",Serie ${s} S01E${String(ep).padStart(2, "0")}`, `http://prov.example:8080/series/usuario/senha/${i}.mp4`];
}
async function* source() {
  yield "#EXTM3U\r\n";
  let buf = [];
  for (let i = 0; i < N; i++) {
    const [a, b] = entry(i);
    buf.push(a, b);
    if (buf.length >= 2000) { yield buf.join("\r\n") + "\r\n"; buf = []; }
  }
  if (buf.length) yield buf.join("\r\n") + "\r\n";
}

const mb = (x) => (x / 1048576).toFixed(1);
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
const t0 = process.hrtime.bigint();
let count = 0, bytes = 0, kinds = {};

if (mode === "stream") {
  const stats = {};
  for await (const it of parseM3UStream(source(), { stats })) { count++; kinds[it.kind] = (kinds[it.kind] ?? 0) + 1; }
  bytes = stats.bytes;
} else {
  const parts = [];
  for await (const c of source()) { parts.push(Buffer.from(c)); }
  const text = Buffer.concat(parts).toString("utf8"); // como fetchM3U faz hoje
  bytes = text.length;
  const items = M3UService.parse(text);
  count = items.length;
  for (const it of items) kinds[it.type] = (kinds[it.type] ?? 0) + 1;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
clearInterval(sample);
peak = Math.max(peak, process.memoryUsage().rss);
console.log(JSON.stringify({ mode, itens: count, tamanhoMB: Number(mb(bytes)), tempoMs: Math.round(ms), picoRssMB: Number(mb(peak)), tipos: kinds }));
