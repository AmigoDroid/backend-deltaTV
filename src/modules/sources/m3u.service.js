export function parseEpisode(title) {
  if (!title) return null;

  const marker =
    title.match(/\bS(\d{1,3})\s*E(\d{1,4})\b/i) ||
    title.match(/\b(\d{1,3})x(\d{1,4})\b/i);

  if (!marker) return null;

  const before = title.slice(0, marker.index).trim();
  const after = title
    .slice(marker.index + marker[0].length)
    .replace(/^[\s\-_.:]+/, "")
    .trim();

  // Exemplo:
  // José do Egito S01 José do Egito - S01E01 - Episódio 1
  // O nome da série fica "José do Egito".
  let seriesTitle = before;

  const seasonMatch = before.match(/\bS\d{1,3}\b/i);

  if (seasonMatch) {
    seriesTitle = before.slice(0, seasonMatch.index).trim();
  }

  seriesTitle = seriesTitle.replace(/[\s\-_.:|]+$/g, "").trim();

  // Alguns provedores repetem o nome da série depois do marcador
  // S01. Nesse caso, remove a repetição do título do episódio.
  let episodeTitle = after;

  if (seriesTitle && episodeTitle) {
    const escaped = seriesTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    episodeTitle = episodeTitle
      .replace(new RegExp("^" + escaped + "\\s*[-:|]*\\s*", "i"), "")
      .trim();
  }

  return {
    seriesTitle: seriesTitle || title.slice(0, marker.index).trim() || title,
    season: Number(marker[1]),
    episode: Number(marker[2]),
    episodeTitle: episodeTitle || `Episódio ${Number(marker[2])}`,
  };
}

export function classifyContent(group, url, title, episodeInfo) {
  const g = (group || "").normalize("NFC").trim().toLowerCase();
  const u = (url || "").toLowerCase();
  const t = (title || "").toLowerCase();

  // A URL explícita tem prioridade sobre nomes ambíguos de grupos.
  if (/\/live\//i.test(u)) return "canais";
  if (/\/movie\//i.test(u)) return "filmes";
  if (/\/series\//i.test(u)) return "series";

  // Grupos de séries da playlist analisada.
  if (/^s[ée]ries?\s*[|:]/i.test(g)) return "series";

  // Grupos de filmes.
  if (/^filmes?\s*[:|]/i.test(g)) return "filmes";
  if (/^filmes?\s*-/i.test(g)) return "filmes";

  // Grupos de canais ao vivo.
  if (/^canais?\s*[|:]/i.test(g)) return "canais";

  // Conteúdos com identificação explícita de episódio.
  if (episodeInfo) return "series";

  // Grupos de séries que não usam necessariamente o prefixo "SÉRIES".
  if (/\b(temporada|season|episódios|episodios|tv shows)\b/i.test(g)) {
    return "series";
  }

  // Grupos típicos de filmes.
  if (/\b(filmes|filme|movies|cinema|lançamentos|lancamentos)\b/i.test(g)) {
    return "filmes";
  }

  // Não classifica como filme apenas porque o título tem um ano.
  // Grupos ambíguos ficam como canais por compatibilidade,
  // podendo ser refinados conforme a estrutura do provedor.
  return "canais";
}

// Monta um item a partir da linha #EXTINF e da URL que a segue.
function buildItem(linha, srcVideo) {
  const titleMatch = linha.match(/,(.*)$/);
  const tvgNameMatch = linha.match(/\btvg-name="([^"]*)"/i);
  const imageMatch = linha.match(/\btvg-logo="([^"]*)"/i);
  const groupMatch = linha.match(/\bgroup-title="([^"]*)"/i);
  const tvgIdMatch = linha.match(/\btvg-id="([^"]*)"/i);

  const title = titleMatch?.[1]?.trim() || "Sem título";
  const tvgName = tvgNameMatch?.[1]?.trim() || title;
  const srcImage = imageMatch?.[1]?.trim() || "";
  const group = groupMatch?.[1]?.trim() || "Sem categoria";
  const tvgId = tvgIdMatch?.[1]?.trim() || "";

  const episodeInfo = parseEpisode(tvgName);
  const type = classifyContent(group, srcVideo, tvgName, episodeInfo);

  return {
    title,
    tvgName,
    tvgId,
    srcVideo,
    srcImage,
    group,
    type,
    ...(type === "series" && episodeInfo ? episodeInfo : {}),
  };
}

const MAX_LINE_CHARS = 4 * 1024 * 1024; // uma única linha nunca deveria passar disso

class M3UService {
  static parse(m3u) {
    if (!m3u || typeof m3u !== "string") return [];

    const linhas = m3u
      .replace(/^\uFEFF/, "")
      .replace(/([^\r\n])(?=#EXTINF)/g, "$1\n")
      .split(/\r?\n/)
      .map((linha) => linha.trim())
      .filter(Boolean);

    const items = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];

      if (!linha.startsWith("#EXTINF:")) continue;

      // Procura a próxima linha que não seja comentário.
      let j = i + 1;

      while (j < linhas.length && linhas[j].startsWith("#")) {
        j++;
      }

      const srcVideo = linhas[j];

      if (!srcVideo) continue;

      items.push(buildItem(linha, srcVideo));

      i = j;
    }

    return items;
  }

  /**
   * Mesmo resultado de parse(), mas lendo em stream (iterável assíncrono de Buffers):
   * o texto da playlist nunca é montado inteiro, então não há teto de ~500 MB —
   * o limite passa a ser apenas a memória dos itens já interpretados.
   * Lança Error com code "INVALID_M3U" se o início não for #EXTM3U.
   */
  static async parseStream(chunks) {
    const decoder = new TextDecoder("utf-8");
    const items = [];
    let tail = "";
    let headerChecked = false;
    let junkLines = 0;
    let pending = null; // linha #EXTINF aguardando a URL

    const invalid = (msg) => Object.assign(new Error(msg), { code: "INVALID_M3U" });

    const handleLine = (raw) => {
      const linha = raw.trim();
      if (!linha) return;
      if (!headerChecked) {
        // Alguns provedores mandam um aviso ("access denied" etc.) antes da lista: ignora até achar #EXTM3U.
        if (!/^#EXTM3U/i.test(linha.replace(/^\uFEFF/, ""))) {
          if (++junkLines > 50) throw invalid("Cabeçalho #EXTM3U ausente.");
          return;
        }
        headerChecked = true;
      }
      if (linha.startsWith("#")) {
        if (pending === null && linha.startsWith("#EXTINF:")) pending = linha;
        return; // comentários entre #EXTINF e a URL são ignorados
      }
      if (pending !== null) {
        items.push(buildItem(pending, linha));
        pending = null;
      }
    };

    const feed = (text) => {
      const data = tail + text;
      const lastNl = data.lastIndexOf("\n");
      if (lastNl === -1) {
        if (data.length > MAX_LINE_CHARS) throw invalid("Linha da playlist grande demais.");
        tail = data;
        return;
      }
      tail = data.slice(lastNl + 1);
      // Alguns provedores colam #EXTINF no fim da linha anterior.
      const block = data.slice(0, lastNl).replace(/([^\r\n])(?=#EXTINF)/g, "$1\n");
      let from = 0;
      for (;;) {
        const nl = block.indexOf("\n", from);
        if (nl === -1) {
          handleLine(block.slice(from));
          break;
        }
        handleLine(block.slice(from, nl));
        from = nl + 1;
      }
    };

    for await (const chunk of chunks) feed(decoder.decode(chunk, { stream: true }));
    feed(decoder.decode() + "\n");
    if (!headerChecked) throw invalid("Playlist vazia.");
    return items;
  }
}

export default M3UService;
