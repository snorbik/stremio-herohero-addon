#!/usr/bin/env node
/**
 * Diagnostický skript – zjistí dostupné video streamy pro HeroHero epizodu.
 * Použití: node test-video-quality.js <refreshToken2> <postId>
 *
 * postId = GUID epizody z RSS feedu (bez prefixu "herohero:")
 * Příklad: node test-video-quality.js eyJ... zivotyslavnychilxmsrdorrvrcnmxpfcttgxmpwg
 */
const fetch = require('node-fetch')
const crypto = require('crypto')

const GRAPHQL_URL = 'https://svc-prod.herohero.co/graphql/'
const REFRESH_URL = 'https://svc-prod.herohero.co/auth/v1/oauth/refresh'
const DEVICE_ID   = crypto.randomBytes(16).toString('base64url')

const [,, refreshToken, postId] = process.argv.map(a => a?.trim())

if (!refreshToken || !postId) {
    console.error('Použití: node test-video-quality.js <refreshToken2> <postId>')
    console.error('postId = GUID epizody z RSS feedu (bez prefixu "herohero:")')
    process.exit(1)
}

const COMMON = {
    'Accept': '*/*',
    'Origin': 'https://herohero.co',
    'Referer': 'https://herohero.co/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Device-Id': DEVICE_ID
}

// --- Rozšířený GraphQL dotaz – zkusí všechna pravděpodobná video pole ---
const FULL_ASSETS_QUERY = `
query GetPostDetailPageQuery($id: ID!) {
  post(id: $id) {
    __typename
    id
    ... on CompleteContentPost {
      title
      assets {
        __typename
        ... on PostGjirafaAsset {
          gjirafaId
          thumbnailUrl
          hasVideo
          videoStreamUrl
          audioStaticUrl
          audioStreamUrl
        }
      }
    }
    ... on PreviewContentPost {
      title
    }
  }
}
`

// --- Introspekce: vypíše všechna pole PostGjirafaAsset ---
const INTROSPECT_QUERY = `
{
  __type(name: "PostGjirafaAsset") {
    name
    fields {
      name
      type {
        name
        kind
        ofType { name kind }
      }
    }
  }
}
`

function parseJwtExpiry(jwt) {
    try {
        const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
        const rem = p.exp - Math.floor(Date.now() / 1000)
        return rem > 0 ? `platí ještě ${rem}s` : `EXPIROVAL před ${-rem}s`
    } catch { return '?' }
}

function extractCookie(headers, name) {
    const raw = headers.raw?.()?.['set-cookie'] || []
    const all = Array.isArray(raw) ? raw : [headers.get('set-cookie') || '']
    for (const h of all) {
        const m = h.match(new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`))
        if (m) return m[1]
    }
    return null
}

async function refreshAccessToken(rt) {
    console.log('\n[1] Obnova accessToken2 přes /auth/v1/oauth/refresh...')
    const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { ...COMMON, 'Cookie': `refreshToken2=${rt}`, 'Content-Length': '0' },
        timeout: 15000
    })
    console.log('    HTTP:', res.status)
    if (!res.ok) throw new Error(`Token refresh selhal: ${res.status}`)
    const at = extractCookie(res.headers, 'accessToken2')
    if (!at) throw new Error('Refresh nevrátil accessToken2')
    console.log('    Nový accessToken2:', parseJwtExpiry(at))
    return at
}

async function gql(accessToken, query, variables = {}) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { ...COMMON, 'Content-Type': 'application/json', 'Cookie': `accessToken2=${accessToken}` },
        body: JSON.stringify({ query, variables }),
        timeout: 15000
    })
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`)
    return res.json()
}

// --- Parsování HLS m3u8 master playlistu ---
async function fetchAndParseHLS(url) {
    const res = await fetch(url, { headers: { 'User-Agent': COMMON['User-Agent'] }, timeout: 15000 })
    if (!res.ok) throw new Error(`HLS fetch ${res.status}`)
    const text = await res.text()
    return parseM3U8(text, url)
}

function parseM3U8(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim())
    const renditions = []

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // EXT-X-STREAM-INF = video rendition
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length))
            const uri = lines[i + 1]
            if (uri && !uri.startsWith('#')) {
                renditions.push({
                    type: 'video',
                    bandwidth: parseInt(attrs.BANDWIDTH || '0'),
                    resolution: attrs.RESOLUTION || '?',
                    codecs: attrs.CODECS || '',
                    frameRate: attrs['FRAME-RATE'] || '',
                    uri: resolveUrl(uri, baseUrl)
                })
            }
        }
        // EXT-X-MEDIA = audio-only rendition
        if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
            const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length))
            if (attrs.URI) {
                renditions.push({
                    type: 'audio',
                    groupId: attrs['GROUP-ID'] || '',
                    name: attrs.NAME || '',
                    language: attrs.LANGUAGE || '',
                    uri: resolveUrl(attrs.URI, baseUrl)
                })
            }
        }
    }
    return { raw: text.substring(0, 800), renditions }
}

function parseAttrs(str) {
    const result = {}
    const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g
    let m
    while ((m = re.exec(str)) !== null) {
        result[m[1]] = m[2] !== undefined ? m[2] : m[3]
    }
    return result
}

function resolveUrl(uri, base) {
    if (uri.startsWith('http')) return uri
    try { return new URL(uri, base).href } catch { return uri }
}

// ---------------------------------------------------------------------------
async function main() {
    const at = await refreshAccessToken(refreshToken)

    // --- Introspekce schématu ---
    console.log('\n[2] Introspekce: pole PostGjirafaAsset...')
    try {
        const intro = await gql(at, INTROSPECT_QUERY)
        const fields = intro.data?.__type?.fields || []
        if (fields.length) {
            console.log('    Dostupná pole:')
            for (const f of fields) {
                const t = f.type.ofType ? `${f.type.ofType.kind}(${f.type.ofType.name})` : `${f.type.kind}(${f.type.name})`
                console.log(`      - ${f.name}: ${t}`)
            }
        } else {
            console.log('    Introspekce nic nevrátila (nebo je zakázána)')
        }
    } catch (e) {
        console.log('    Introspekce selhala:', e.message)
    }

    // --- Full assets dotaz ---
    console.log(`\n[3] GraphQL dotaz na post: ${postId}`)
    const data = await gql(at, FULL_ASSETS_QUERY, { id: postId })
    if (data.errors?.length) {
        console.error('    GraphQL errors:', data.errors.map(e => e.message).join('; '))
    }
    const post = data.data?.post
    if (!post) { console.error('    Post nenalezen'); return }

    console.log('    Typ:', post.__typename)
    if (post.title) console.log('    Název:', post.title)

    const assets = post.assets || []
    console.log(`    Počet assets: ${assets.length}`)

    for (const [i, asset] of assets.entries()) {
        console.log(`\n    Asset[${i}]: __typename=${asset.__typename}`)
        console.log('    Celá data asset:')
        console.log(JSON.stringify(asset, null, 6).replace(/^/gm, '    '))

        if (asset.videoStreamUrl) {
            console.log(`\n[4] Parsování HLS master playlistu pro asset[${i}]...`)
            console.log('    URL:', asset.videoStreamUrl)
            try {
                const { raw, renditions } = await fetchAndParseHLS(asset.videoStreamUrl)
                const videos = renditions.filter(r => r.type === 'video')
                const audios = renditions.filter(r => r.type === 'audio')

                if (videos.length === 0) {
                    console.log('\n    ⚠ Žádné video renditions v playlistu. Zkrácený obsah m3u8:')
                    console.log(raw.split('\n').map(l => '    ' + l).join('\n'))
                } else {
                    console.log(`\n    Video renditions (${videos.length} kvalit):`)
                    videos.sort((a, b) => b.bandwidth - a.bandwidth)
                    for (const v of videos) {
                        const kbps = Math.round(v.bandwidth / 1000)
                        console.log(`      [${kbps} kbps] ${v.resolution} fps=${v.frameRate} url=${v.uri}`)
                    }
                    console.log('\n    Nejlepší kvalita (nejvyšší bitrate):')
                    console.log('    ', videos[0].uri)
                }

                if (audios.length) {
                    console.log(`\n    Audio renditions (${audios.length}):`)
                    for (const a of audios) {
                        console.log(`      [${a.name}] lang=${a.language} url=${a.uri}`)
                    }
                }
            } catch (e) {
                console.error('    HLS parse chyba:', e.message)
            }
        }
    }

    console.log('\nHotovo.')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
