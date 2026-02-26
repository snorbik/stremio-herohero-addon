const fetch = require('node-fetch')
const { XMLParser } = require('fast-xml-parser')

// In-memory cache: url -> { data, timestamp }
const cache = new Map()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hodina

async function fetchFeed(url) {
    const cached = cache.get(url)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data
    }

    let response
    try {
        response = await fetch(url, {
            headers: { 'User-Agent': 'StremioHeroHeroAddon/1.0' },
            timeout: 15000
        })
    } catch (err) {
        // Pokud máme zastaralý cache, vrátíme ho při chybě sítě
        if (cached) return cached.data
        throw new Error(`Nepodařilo se načíst RSS feed: ${err.message}`)
    }

    if (!response.ok) {
        if (cached) return cached.data
        throw new Error(`RSS feed vrátil chybu: ${response.status} ${response.statusText}`)
    }

    const xml = await response.text()
    const data = parseRSS(xml)

    cache.set(url, { data, timestamp: Date.now() })
    return data
}

function parseRSS(xml) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        // 'item' je vždy pole (i když je jen jedna epizoda)
        isArray: (name) => name === 'item'
    })

    const result = parser.parse(xml)
    const channel = result?.rss?.channel
    if (!channel) throw new Error('Neplatný formát RSS feedu')

    const title = getText(channel.title) || 'HeroHero Feed'
    const description = getText(channel.description) || ''

    // Obrázek kanálu - zkusíme itunes:image, pak standardní image
    const channelImage =
        channel['itunes:image']?.['@_href'] ||
        channel.image?.url ||
        ''

    const episodes = (channel.item || [])
        .map(item => parseItem(item, channelImage, title))
        .filter(ep => ep.guid && ep.enclosureUrl)

    return { title, description, image: channelImage, episodes }
}

// Odstraní query string – vrátí čistou URL obrázku bez CDN transformací
function stripQuery(url) {
    if (!url) return url
    const q = url.indexOf('?')
    return q !== -1 ? url.slice(0, q) : url
}

function parseItem(item, channelImage, channelTitle) {
    // GUID může být buď string nebo objekt { #text, @_isPermaLink }
    const guid =
        typeof item.guid === 'object' ? item.guid['#text'] : item.guid

    const enclosure = item.enclosure || {}
    const enclosureUrl = enclosure['@_url'] || ''
    const enclosureLength = parseInt(enclosure['@_length'] || '0', 10)
    const enclosureType = enclosure['@_type'] || ''

    // Obrázek epizody z itunes:image bez CDN transformací (plain PNG)
    const episodeImage = stripQuery(item['itunes:image']?.['@_href'] || channelImage)

    // Popis; pokud je jen název kanálu, necháme prázdné
    const rawDesc = getText(item.description) || ''
    const description = rawDesc === channelTitle ? '' : rawDesc

    // Délka v sekundách -> čitelný formát (napr. "25m" nebo "1h 2m")
    const durationSec = parseInt(item['itunes:duration'] || '0', 10)
    const runtime = durationSec > 0 ? formatDuration(durationSec) : undefined

    let pubDate
    try {
        pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
    } catch {
        pubDate = new Date().toISOString()
    }

    return {
        guid: String(guid || '').trim(),
        title: getText(item.title) || 'Bez názvu',
        description,
        pubDate,
        image: episodeImage,
        enclosureUrl,
        enclosureLength,
        enclosureType,
        runtime,
        link: getText(item.link) || ''
    }
}

function getText(val) {
    if (val == null) return ''
    if (typeof val === 'string') return val.trim()
    if (typeof val === 'object' && val['#text'] != null) return String(val['#text']).trim()
    return String(val).trim()
}

function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}

module.exports = { fetchFeed }
