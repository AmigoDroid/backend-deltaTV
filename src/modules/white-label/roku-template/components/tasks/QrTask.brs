sub init()
    m.top.functionName = "buildQrMatrix"
end sub

sub buildQrMatrix()
    pairingUrl = m.top.pairingUrl
    m.top.pairingUrl = ""
    result = { ok: false, message: "Não foi possível gerar o QR Code.", matrix: [] }

    if pairingUrl = invalid or pairingUrl = "" then
        result.message = "O servidor não retornou o endereço temporário do pareamento."
        m.top.result = result
        return
    end if

    version = 0
    for candidate = 1 to 10
        if Len(pairingUrl) <= QrDataCapacity(candidate) then
            version = candidate
            exit for
        end if
    end for
    if version = 0 then
        result.message = "O endereço de pareamento é grande demais para gerar o QR Code."
        m.top.result = result
        return
    end if

    dataWords = QrEncodeData(pairingUrl, version)
    codewords = QrAddErrorCorrection(dataWords, version)
    result.matrix = QrBuildMatrix(codewords, version)
    result.version = version

    ' Autoverificacao: a versao 2+ precisa do padrao de alinhamento no canto inferior direito (anel escuro / anel claro / centro).
    if version >= 2 then
        last = result.matrix.count() - 7
        if result.matrix[last][last] <> 1 or result.matrix[last - 1][last - 1] <> 0 or result.matrix[last - 2][last - 2] <> 1 or result.matrix[last + 2][last + 2] <> 1 then
            result.message = "Falha interna no QR (alinhamento v" + version.toStr() + ")."
            m.top.result = result
            return
        end if
    end if

    result.ok = true
    result.message = ""
    m.top.result = result
end sub

function QrDataCapacity(version as Integer) as Integer
    dataWords = QrDataWordCount(version)
    if version <= 9 then return dataWords - 2
    return dataWords - 3
end function

function QrDataWordCount(version as Integer) as Integer
    groups = QrBlockGroups(version, "data")
    counts = QrBlockGroups(version, "count")
    total = 0
    for i = 0 to groups.count() - 1
        total = total + groups[i] * counts[i]
    end for
    return total
end function

function QrBlockGroups(version as Integer, kind as String) as Object
    if kind = "count" then
        if version <= 5 then return [1]
        if version <= 9 then return [2]
        return [2, 2]
    end if
    if version = 1 then return [19]
    if version = 2 then return [34]
    if version = 3 then return [55]
    if version = 4 then return [80]
    if version = 5 then return [108]
    if version = 6 then return [68]
    if version = 7 then return [78]
    if version = 8 then return [97]
    if version = 9 then return [116]
    return [68, 69]
end function

function QrBlockTotals(version as Integer) as Object
    if version = 1 then return [26]
    if version = 2 then return [44]
    if version = 3 then return [70]
    if version = 4 then return [100]
    if version = 5 then return [134]
    if version = 6 then return [86]
    if version = 7 then return [98]
    if version = 8 then return [121]
    if version = 9 then return [146]
    return [86, 87]
end function

function QrEncodeData(text as String, version as Integer) as Object
    bits = []
    QrAppendBits(bits, 4, 4)
    countBits = 8
    if version >= 10 then countBits = 16
    QrAppendBits(bits, Len(text), countBits)

    for i = 1 to Len(text)
        QrAppendBits(bits, Asc(Mid(text, i, 1)), 8)
    end for

    capacity = QrDataWordCount(version) * 8
    terminator = 4
    if capacity - bits.count() < terminator then terminator = capacity - bits.count()
    if terminator > 0 then QrAppendBits(bits, 0, terminator)
    while bits.count() mod 8 <> 0
        bits.push(0)
    end while

    words = []
    for i = 0 to bits.count() - 1 step 8
        value = 0
        for j = 0 to 7
            value = value * 2 + bits[i + j]
        end for
        words.push(value)
    end for

    pad = 236
    while words.count() < QrDataWordCount(version)
        words.push(pad)
        if pad = 236 then
            pad = 17
        else
            pad = 236
        end if
    end while
    return words
end function

sub QrAppendBits(bits as Object, value as Integer, count as Integer)
    for i = count - 1 to 0 step -1
        bits.push(QrBitAt(value, i))
    end for
end sub

function QrAddErrorCorrection(dataWords as Object, version as Integer) as Object
    groupCounts = QrBlockGroups(version, "count")
    groupData = QrBlockGroups(version, "data")
    groupTotals = QrBlockTotals(version)
    blocks = []
    cursor = 0

    for group = 0 to groupCounts.count() - 1
        for blockIndex = 1 to groupCounts[group]
            block = []
            for i = 0 to groupData[group] - 1
                block.push(dataWords[cursor])
                cursor = cursor + 1
            end for
            eccLength = groupTotals[group] - groupData[group]
            blocks.push({ data: block, ecc: QrReedSolomon(block, eccLength) })
        end for
    end for

    result = []
    maxDataLength = 0
    maxEccLength = 0
    for each block in blocks
        if block.data.count() > maxDataLength then maxDataLength = block.data.count()
        if block.ecc.count() > maxEccLength then maxEccLength = block.ecc.count()
    end for
    for i = 0 to maxDataLength - 1
        for each block in blocks
            if i < block.data.count() then result.push(block.data[i])
        end for
    end for
    for i = 0 to maxEccLength - 1
        for each block in blocks
            if i < block.ecc.count() then result.push(block.ecc[i])
        end for
    end for
    return result
end function

function QrReedSolomon(data as Object, degree as Integer) as Object
    generator = [1]
    root = 1
    for i = 0 to degree - 1
        nextGenerator = []
        for j = 0 to generator.count()
            nextGenerator.push(0)
        end for
        for j = 0 to generator.count() - 1
            nextGenerator[j] = QrBitXor(nextGenerator[j], generator[j])
            nextGenerator[j + 1] = QrBitXor(nextGenerator[j + 1], QrGfMultiply(generator[j], root))
        end for
        generator = nextGenerator
        root = QrGfMultiply(root, 2)
    end for

    work = []
    for each value in data
        work.push(value)
    end for
    for i = 1 to degree
        work.push(0)
    end for
    for i = 0 to data.count() - 1
        factor = work[i]
        for j = 0 to generator.count() - 1
            work[i + j] = QrBitXor(work[i + j], QrGfMultiply(factor, generator[j]))
        end for
    end for

    ecc = []
    for i = data.count() to work.count() - 1
        ecc.push(work[i])
    end for
    return ecc
end function

function QrBitAt(value as Integer, index as Integer) as Integer
    return Int(value / (2 ^ index)) mod 2
end function

function QrBitXor(left as Integer, right as Integer) as Integer
    result = 0
    place = 1
    while left > 0 or right > 0
        leftBit = left mod 2
        rightBit = right mod 2
        if leftBit <> rightBit then result = result + place
        left = Int(left / 2)
        right = Int(right / 2)
        place = place * 2
    end while
    return result
end function

function QrGfMultiply(left as Integer, right as Integer) as Integer
    product = 0
    while right > 0
        if right mod 2 <> 0 then product = QrBitXor(product, left)
        right = Int(right / 2)
        left = left * 2
        if left >= 256 then left = QrBitXor(left, 285)
    end while
    return product
end function

function QrBuildMatrix(codewords as Object, version as Integer) as Object
    size = 17 + version * 4
    matrix = []
    for y = 0 to size - 1
        row = []
        for x = 0 to size - 1
            row.push(-1)
        end for
        matrix.push(row)
    end for

    QrDrawFinder(matrix, size, 0, 0)
    QrDrawFinder(matrix, size, size - 7, 0)
    QrDrawFinder(matrix, size, 0, size - 7)
    QrDrawTiming(matrix, size)
    QrDrawAlignment(matrix, size, version)
    QrReserveFormat(matrix, size)
    if version >= 7 then QrReserveVersion(matrix, size)
    QrPlaceData(matrix, size, codewords)
    QrWriteFormat(matrix, size, 0)
    if version >= 7 then QrWriteVersion(matrix, size, version)
    matrix[size - 8][8] = 1
    return matrix
end function

sub QrDrawFinder(matrix as Object, size as Integer, left as Integer, top as Integer)
    for dy = -1 to 7
        for dx = -1 to 7
            x = left + dx
            y = top + dy
            if x >= 0 and x < size and y >= 0 and y < size then
                dark = 0
                if dx >= 0 and dx <= 6 and dy >= 0 and dy <= 6 then
                    ax = Abs(dx - 3)
                    ay = Abs(dy - 3)
                    if ax > ay then distance = ax else distance = ay
                    if distance = 3 or distance <= 1 then dark = 1
                end if
                matrix[y][x] = dark
            end if
        end for
    end for
end sub

sub QrDrawTiming(matrix as Object, size as Integer)
    for i = 8 to size - 9
        if matrix[6][i] = -1 then matrix[6][i] = 1 - (i mod 2)
        if matrix[i][6] = -1 then matrix[i][6] = 1 - (i mod 2)
    end for
end sub

function QrAlignPositions(version as Integer) as Object
    if version = 2 then return [6, 18]
    if version = 3 then return [6, 22]
    if version = 4 then return [6, 26]
    if version = 5 then return [6, 30]
    if version = 6 then return [6, 34]
    if version = 7 then return [6, 22, 38]
    if version = 8 then return [6, 24, 42]
    if version = 9 then return [6, 26, 46]
    if version = 10 then return [6, 28, 50]
    return []
end function

' Padrao de alinhamento 5x5 (anel escuro, anel claro, centro escuro). Escrito com laços/ifs simples e sem "not (... or ...)".
sub QrDrawAlignment(matrix as Object, size as Integer, version as Integer)
    positions = QrAlignPositions(version)
    total = positions.count()
    if total = 0 then return
    lastPos = size - 7

    for i = 0 to total - 1
        for j = 0 to total - 1
            cy = positions[i]
            cx = positions[j]
            skip = false
            if cx = 6 and cy = 6 then skip = true
            if cx = lastPos and cy = 6 then skip = true
            if cx = 6 and cy = lastPos then skip = true
            if skip = false then
                for dy = -2 to 2
                    for dx = -2 to 2
                        ax = Abs(dx)
                        ay = Abs(dy)
                        distance = ax
                        if ay > ax then distance = ay
                        dark = 0
                        if distance = 2 then dark = 1
                        if distance = 0 then dark = 1
                        matrix[cy + dy][cx + dx] = dark
                    end for
                end for
            end if
        end for
    end for
end sub

sub QrReserveFormat(matrix as Object, size as Integer)
    for i = 0 to 5
        matrix[i][8] = 0
    end for
    matrix[7][8] = 0
    matrix[8][8] = 0
    matrix[8][7] = 0
    for i = 9 to 14
        matrix[8][14 - i] = 0
    end for
    for i = 0 to 7
        matrix[8][size - 1 - i] = 0
    end for
    for i = 8 to 14
        matrix[size - 15 + i][8] = 0
    end for
    matrix[size - 8][8] = 1
end sub

sub QrReserveVersion(matrix as Object, size as Integer)
    for i = 0 to 17
        x = size - 11 + (i mod 3)
        y = Int(i / 3)
        matrix[y][x] = 0
        matrix[x][y] = 0
    end for
end sub

sub QrPlaceData(matrix as Object, size as Integer, codewords as Object)
    bitIndex = 0
    upward = true
    right = size - 1
    while right >= 1
        if right = 6 then right = right - 1
        for verticalIndex = 0 to size - 1
            if upward then y = size - 1 - verticalIndex else y = verticalIndex
            for offset = 0 to 1
                x = right - offset
                if matrix[y][x] = -1 then
                    bit = 0
                    wordIndex = Int(bitIndex / 8)
                    if wordIndex < codewords.count() then
                        bit = QrBitAt(codewords[wordIndex], 7 - (bitIndex mod 8))
                    end if
                    if (x + y) mod 2 = 0 then bit = 1 - bit
                    matrix[y][x] = bit
                    bitIndex = bitIndex + 1
                end if
            end for
        end for
        upward = not upward
        right = right - 2
    end while
end sub

sub QrWriteFormat(matrix as Object, size as Integer, mask as Integer)
    formatData = 8 + mask
    remainder = formatData * (2 ^ 10)
    for i = 14 to 10 step -1
        if QrBitAt(remainder, i) <> 0 then
            remainder = QrBitXor(remainder, 1335 * (2 ^ (i - 10)))
        end if
    end for
    formatBits = QrBitXor(formatData * (2 ^ 10) + remainder, 21522)

    for i = 0 to 5
        matrix[i][8] = QrBitAt(formatBits, i)
    end for
    matrix[7][8] = QrBitAt(formatBits, 6)
    matrix[8][8] = QrBitAt(formatBits, 7)
    matrix[8][7] = QrBitAt(formatBits, 8)
    for i = 9 to 14
        matrix[8][14 - i] = QrBitAt(formatBits, i)
    end for
    for i = 0 to 7
        matrix[8][size - 1 - i] = QrBitAt(formatBits, i)
    end for
    for i = 8 to 14
        matrix[size - 15 + i][8] = QrBitAt(formatBits, i)
    end for
end sub

sub QrWriteVersion(matrix as Object, size as Integer, version as Integer)
    remainder = version * (2 ^ 12)
    for i = 17 to 12 step -1
        if QrBitAt(remainder, i) <> 0 then
            remainder = QrBitXor(remainder, 7973 * (2 ^ (i - 12)))
        end if
    end for
    versionBits = version * (2 ^ 12) + remainder
    for i = 0 to 17
        bit = QrBitAt(versionBits, i)
        x = size - 11 + (i mod 3)
        y = Int(i / 3)
        matrix[y][x] = bit
        matrix[x][y] = bit
    end for
end sub
