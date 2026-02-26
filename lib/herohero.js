const fetch = require('node-fetch')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const GRAPHQL_URL = 'https://svc-prod.herohero.co/graphql/'
const REFRESH_URL = 'https://svc-prod.herohero.co/auth/v1/oauth/refresh'

// Stabilní Device-Id pro tuto instanci serveru (server jen sleduje, nevaliduje)
const DEVICE_ID = crypto.randomBytes(16).toString('base64url')

// Persistentní úložiště refreshTokenů – přežije restart serveru
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'tokens.json')

function loadTokenStore() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) } catch { return {} }
}

function saveTokenStore(store) {
    try {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2))
    } catch (e) { console.warn('[herohero] Nepodařilo se uložit token:', e.message) }
}

function getUserKey(jwt) {
    try {
        const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
        return p.sub || null
    } catch { return null }
}

// Post a PostAsset jsou union typy – přistupujeme přes inline fragmenty
const GET_POST_ASSETS_QUERY = `
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
          audioStaticUrl
          audioStreamUrl
          videoStreamUrl
        }
      }
    }
    ... on PreviewContentPost {
      title
    }
  }
}
`

const COMMON_HEADERS = {
    'Accept': '*/*',
    'Origin': 'https://herohero.co',
    'Referer': 'https://herohero.co/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Device-Id': DEVICE_ID
}

// Cache: refreshToken → { accessToken, refreshToken, expiresAt }
const tokenCache = new Map()

function parseJwtExpiry(jwt) {
    try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
        return payload.exp ? payload.exp * 1000 : null
    } catch { return null }
}

function extractSetCookie(response, name) {
    // node-fetch v2 vrací set-cookie jako jeden string nebo přes getAll
    const raw = response.headers.raw?.()?.['set-cookie'] || []
    const all = Array.isArray(raw) ? raw : [response.headers.get('set-cookie') || '']
    for (const h of all) {
        const m = h.match(new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`))
        if (m) return m[1]
    }
    return null
}

/**
 * Obnoví accessToken2 voláním /auth/v1/oauth/refresh s refreshToken2 cookie.
 * Server vrátí 204 + Set-Cookie s novým accessToken2 (a novým refreshToken2).
 */
async function refreshAccessToken(refreshToken) {
    console.log('[herohero] Obnovuji accessToken2 přes /auth/v1/oauth/refresh...')
    const rt = refreshToken.trim()

    const response = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: {
            ...COMMON_HEADERS,
            'Cookie': `refreshToken2=${rt}`,
            'Content-Length': '0'
        },
        timeout: 15000
    })

    if (!response.ok) {
        throw new Error(`Token refresh selhal: ${response.status} ${response.statusText}`)
    }

    const newAt = extractSetCookie(response, 'accessToken2')
    const newRt = extractSetCookie(response, 'refreshToken2')

    if (!newAt) {
        const raw = response.headers.get('set-cookie') || ''
        console.error('[herohero] Set-Cookie header:', raw.substring(0, 300))
        throw new Error('Refresh nevrátil nový accessToken2 v Set-Cookie')
    }

    const expiresAt = parseJwtExpiry(newAt)
    const latestRt = newRt || rt

    // Ulož do paměti
    tokenCache.set(rt, { accessToken: newAt, refreshToken: latestRt, expiresAt })
    if (newRt && newRt !== rt) {
        tokenCache.set(newRt, { accessToken: newAt, refreshToken: newRt, expiresAt })
    }

    // Persistuj nejnovější refreshToken do souboru (přežije restart)
    const userKey = getUserKey(rt) || rt.substring(0, 16)
    const store = loadTokenStore()
    store[userKey] = { refreshToken: latestRt, accessToken: newAt, updatedAt: Date.now() }
    saveTokenStore(store)

    console.log(`[herohero] accessToken2 obnoven, platí do ${expiresAt ? new Date(expiresAt).toISOString() : '?'}`)
    return newAt
}

/**
 * Vrátí platný accessToken2 – z cache, nebo ho obnoví přes refreshToken2.
 */
async function getValidToken(accessToken, refreshToken) {
    const rt = refreshToken.trim()

    const cached = tokenCache.get(rt)
    if (cached && cached.expiresAt && cached.expiresAt > Date.now() + 60_000) {
        return cached.accessToken
    } else if (cached) {
        return await refreshAccessToken(rt)
    }

    // Studený start – zkus nejdřív persistovaný token ze souboru
    const userKey = getUserKey(rt) || rt.substring(0, 16)
    const store = loadTokenStore()
    const persisted = store[userKey]

    let bestRt = rt
    if (persisted?.refreshToken && persisted.refreshToken !== rt) {
        console.log('[herohero] Načítám persistovaný refreshToken ze souboru')
        bestRt = persisted.refreshToken
    }

    const at = persisted?.accessToken?.trim() || accessToken.trim()
    const exp = parseJwtExpiry(at)
    if (exp && exp > Date.now() + 60_000) {
        tokenCache.set(rt, { accessToken: at, refreshToken: bestRt, expiresAt: exp })
        return at
    }

    return await refreshAccessToken(bestRt)
}

/**
 * Načte assety (video/audio URL) pro konkrétní post z HeroHero GraphQL API.
 */
async function getPostAssets(postId, accessToken, refreshToken) {
    const rt = refreshToken.trim()
    const currentAt = await getValidToken(accessToken, refreshToken)

    const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            ...COMMON_HEADERS,
            'Content-Type': 'application/json',
            'Cookie': `accessToken2=${currentAt}`
        },
        body: JSON.stringify({
            operationName: 'GetPostDetailPageQuery',
            query: GET_POST_ASSETS_QUERY,
            variables: { id: postId }
        }),
        timeout: 15000
    })

    if (!response.ok) {
        if ([400, 401, 403, 500].includes(response.status)) tokenCache.delete(rt)
        throw new Error(`HeroHero GraphQL selhal: ${response.status} ${response.statusText}`)
    }

    const json = await response.json()

    if (json.errors?.length) {
        const authError = json.errors.find(e =>
            e.message?.toLowerCase().includes('auth') ||
            e.extensions?.code === 'UNAUTHENTICATED'
        )
        if (authError) {
            tokenCache.delete(rt)
            throw new Error('Neplatný refreshToken — obnov cookie "refreshToken2" v DevTools')
        }
        throw new Error(`GraphQL chyba: ${json.errors[0].message}`)
    }

    const post = json.data?.post
    if (post?.__typename === 'PreviewContentPost') {
        throw new Error('Obsah není dostupný pro toto předplatné (PreviewContentPost)')
    }

    return post?.assets ?? []
}

const GET_SUBSCRIPTIONS_QUERY = `
query GetMySubscriptions($userId: ID!) {
  subscriptions(userId: $userId, first: 50, filter: { expired: false }) {
    nodes {
      creator {
        id
        name
        path
        image { url }
      }
    }
  }
}
`

/**
 * Vrátí seznam aktivních předplatných přihlášeného uživatele.
 */
async function getSubscriptions(accessToken, refreshToken) {
    const currentAt = await getValidToken(accessToken, refreshToken)

    // userId je "sub" claim z JWT
    const userId = getUserKey(currentAt)
    if (!userId) throw new Error('Nepodařilo se načíst userId z access tokenu')

    const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            ...COMMON_HEADERS,
            'Content-Type': 'application/json',
            'Cookie': `accessToken2=${currentAt}`
        },
        body: JSON.stringify({
            operationName: 'GetMySubscriptions',
            query: GET_SUBSCRIPTIONS_QUERY,
            variables: { userId }
        }),
        timeout: 15000
    })

    if (!response.ok) {
        throw new Error(`HeroHero API selhal: ${response.status} ${response.statusText}`)
    }

    const json = await response.json()
    if (json.errors?.length) {
        throw new Error(`GraphQL: ${json.errors[0].message}`)
    }

    const nodes = json.data?.subscriptions?.nodes || []
    return nodes
        .map(n => ({
            id:    n.creator?.id,
            name:  n.creator?.name,
            slug:  n.creator?.path,
            image: n.creator?.image?.url || ''
        }))
        .filter(s => s.name)
}

module.exports = { getPostAssets, getSubscriptions }
