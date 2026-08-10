const fetch = require('node-fetch')

// HeroHero (Gjirafa/vpplayer) dává v master playlistu každé kvalitě vlastní
// audio grupu – 1080p video se páruje s 1080p/audio/index.m3u8. Přímý odkaz
// na rendition proto hraje beze zvuku a musíme sestavit vlastní master
// obsahující jednu video variantu a k ní patřící audio grupu.

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

// Whitelist CDN hostů – bez něj by /hls endpoint fungoval jako otevřená proxy
// pro libovolnou URL, kterou by mu někdo podstrčil.
const ALLOWED_HOST = /(^|\.)vpplayer\.(tech|net)$/i

function isAllowedUrl(url) {
    try { return ALLOWED_HOST.test(new URL(url).hostname) } catch { return false }
}

function parseAttrs(str) {
    const attrs = {}
    const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g
    let m
    while ((m = re.exec(str)) !== null) {
        attrs[m[1]] = m[2] !== undefined ? m[2] : m[3]
    }
    return attrs
}

function resolveUrl(uri, base) {
    try { return new URL(uri, base).href } catch { return uri }
}

/**
 * Rozparsuje HLS master playlist. Raw řádky si držíme beze změny (jen s
 * absolutní URI), aby se nezahodily atributy jako CODECS nebo CHANNELS.
 */
function parseMaster(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim())
    const media = new Map()   // GROUP-ID → { line }
    const variants = []

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
            const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length))
            if (attrs['GROUP-ID'] && attrs.URI) {
                media.set(attrs['GROUP-ID'], {
                    line: line.replace(/URI="[^"]*"/, `URI="${resolveUrl(attrs.URI, baseUrl)}"`)
                })
            }
            continue
        }

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const uri = lines[i + 1]
            if (!uri || uri.startsWith('#')) continue
            const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
            const height = parseInt((attrs.RESOLUTION || '').split('x')[1] || '0', 10)
            variants.push({
                // Pořadí v souboru – slouží jako stabilní identifikátor varianty
                index: variants.length,
                line,
                uri: resolveUrl(uri, baseUrl),
                bandwidth: parseInt(attrs.BANDWIDTH || '0', 10),
                height,
                label: height ? `${height}p` : (attrs.RESOLUTION || 'video'),
                audioGroup: attrs.AUDIO || ''
            })
        }
    }

    // HeroHero master seřazený není (360p bývá první, 1080p až čtvrté), což je
    // přesně důvod, proč přehrávač startuje na nízké kvalitě. Řadíme sestupně.
    variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)

    return { media, variants }
}

async function getMaster(url) {
    if (!isAllowedUrl(url)) throw new Error('Nepovolený CDN host')

    const cached = cache.get(url)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Origin': 'https://herohero.co',
            'Referer': 'https://herohero.co/'
        },
        timeout: 15000
    })
    if (!res.ok) throw new Error(`HLS master vrátil ${res.status}`)

    // Relativní URI schválně rozpouštíme proti původní URL, ne proti té po
    // redirectu – CDN si tak může přehrávače dál rozhazovat mezi svoje nody.
    const data = parseMaster(await res.text(), url)
    cache.set(url, { data, at: Date.now() })
    return data
}

/**
 * Sestaví master playlist obsahující jedinou kvalitu i s jejím audiem.
 */
function buildVariantMaster(master, index) {
    const variant = master.variants.find(v => v.index === index)
    if (!variant) throw new Error('Varianta nenalezena')

    const out = ['#EXTM3U', '#EXT-X-VERSION:3']
    const audio = variant.audioGroup && master.media.get(variant.audioGroup)
    if (audio) out.push(audio.line)
    out.push(variant.line, variant.uri)

    return out.join('\n') + '\n'
}

function encodeStreamRef(masterUrl, index) {
    return Buffer.from(JSON.stringify([masterUrl, index])).toString('base64url')
}

function decodeStreamRef(payload) {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const [url, index] = Array.isArray(parsed) ? parsed : []
    if (typeof url !== 'string' || !Number.isInteger(index)) {
        throw new Error('Neplatný odkaz na stream')
    }
    return { url, index }
}

module.exports = { getMaster, buildVariantMaster, encodeStreamRef, decodeStreamRef }
