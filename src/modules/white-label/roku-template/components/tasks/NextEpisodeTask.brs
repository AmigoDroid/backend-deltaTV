sub init()
    m.top.functionName = "resolveNext"
end sub

function EpisodeIsBefore(a as Object, b as Object) as Boolean
    asn = Int(Val(ToText(a.season)))
    bsn = Int(Val(ToText(b.season)))
    if asn <> bsn then return asn < bsn
    an = Int(Val(ToText(a.num)))
    bn = Int(Val(ToText(b.num)))
    if an <> bn then return an < bn
    return Val(ToText(a.id)) < Val(ToText(b.id))
end function

sub resolveNext()
    req = m.top.request
    out = { ok: false, item: invalid, requestId: req.requestId, reason: "fim da serie" }
    cfgResult = XtGetConfig()
    if not cfgResult.ok then
        out.reason = "configuracao indisponivel"
        m.top.result = out
        return
    end if
    episodes = XtSeriesEpisodes(cfgResult.cfg, ToText(req.seriesId))
    if not episodes.ok then
        out.reason = "falha ao consultar episodios"
        m.top.result = out
        return
    end if
    current = invalid
    for each ep in episodes.episodes
        if ToText(ep.id) = ToText(req.episodeId) then current = ep
    end for
    selected = invalid
    if current = invalid then out.reason = "episodio atual ausente no catalogo"
    if current <> invalid then
        for each ep in episodes.episodes
            if ToText(ep.id) <> ToText(current.id) and EpisodeIsBefore(current, ep) then
                if selected = invalid or EpisodeIsBefore(ep, selected) then selected = ep
            end if
        end for
    end if
    if selected <> invalid then
        seasonText = ToText(selected.season)
        episodeId = ToText(selected.id)
        videoUrl = XtStreamUrl(cfgResult.cfg, "series", episodeId, ToText(selected.ext))
        if videoUrl <> "" then
            title = ToText(selected.title)
            if title = "" then title = "Temporada " + seasonText + " - Episódio " + ToText(selected.num)
            out.item = CopyTrickplayMetadata(selected, {
                id: "ep-" + ToText(req.seriesRef) + "-s" + seasonText + "-e" + episodeId,
                title: title, url: videoUrl, playPath: "",
                streamFormat: GuessStreamFormat(videoUrl), live: false,
                skipResumePrompt: true, seriesRef: ToText(req.seriesRef),
                seriesId: ToText(req.seriesId), seriesEpisodeId: episodeId,
                seriesSeason: seasonText, seriesEpisodeNumber: ToText(selected.num)
            })
            out.ok = true
        end if
    end if
    m.top.result = out
end sub
