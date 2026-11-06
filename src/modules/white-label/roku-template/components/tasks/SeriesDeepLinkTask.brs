sub init()
    m.top.functionName = "resolveSeries"
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

sub resolveSeries()
    req = m.top.request
    result = {ok: false, reason: "", item: invalid}
    if type(req) <> "roAssociativeArray" then
        m.top.result = result
        return
    end if
    cfgResult = XtGetConfig()
    if not cfgResult.ok then
        m.top.result = result
        return
    end if
    epsResult = XtSeriesEpisodes(cfgResult.cfg, ToText(req.seriesId))
    if not epsResult.ok or epsResult.episodes.count() = 0 then
        m.top.result = result
        return
    end if
    earliest = invalid
    last = invalid
    exact = invalid
    smart = VodReadSeriesState(ToText(req.seriesRef))
    for each ep in epsResult.episodes
        if ToText(ep.id) <> "" then
            if earliest = invalid or EpisodeIsBefore(ep, earliest) then earliest = ep
            if smart <> invalid and ToText(ep.id) = ToText(smart.episodeId) then last = ep
            if ToText(ep.id) = ToText(req.episodeId) and ToText(req.episodeId) <> "" then exact = ep
        end if
    end for
    selected = invalid
    reason = "primeiro episodio"
    if ToText(req.mediaType) = "episode" then
        selected = exact
        reason = "episodio solicitado"
    else
        selected = earliest
        if last <> invalid then
            if smart.completed = true then
                nextEp = invalid
                for each ep in epsResult.episodes
                    if ToText(ep.id) <> "" and EpisodeIsBefore(last, ep) then
                        if nextEp = invalid or EpisodeIsBefore(ep, nextEp) then nextEp = ep
                    end if
                end for
                if nextEp <> invalid then
                    selected = nextEp
                    reason = "proximo episodio apos conclusao"
                else
                    selected = last
                    reason = "ultimo episodio da serie"
                end if
            else
                selected = last
                reason = "retomando episodio incompleto"
            end if
        end if
    end if
    if selected = invalid then
        m.top.result = result
        return
    end if
    seasonText = ToText(selected.season)
    episodeNumText = ToText(selected.num)
    episodeId = ToText(selected.id)
    videoUrl = XtStreamUrl(cfgResult.cfg, "series", episodeId, ToText(selected.ext))
    if videoUrl = "" then
        m.top.result = result
        return
    end if
    title = ToText(selected.title)
    if title = "" then title = "Temporada " + seasonText + " - Episodio " + episodeNumText
    result.item = CopyTrickplayMetadata(selected, {
        id: "ep-" + ToText(req.seriesRef) + "-s" + seasonText + "-e" + episodeId,
        title: title,
        url: videoUrl,
        playPath: "",
        streamFormat: GuessStreamFormat(videoUrl),
        live: false,
        skipResumePrompt: true,
        seriesRef: ToText(req.seriesRef),
        seriesId: ToText(req.seriesId),
        seriesEpisodeId: episodeId,
        seriesSeason: seasonText,
        seriesEpisodeNumber: episodeNumText
    })
    result.ok = true
    result.reason = reason
    m.top.result = result
end sub
