#!/usr/bin/env node
/**
 * Testovací skript – ověří přístup k HeroHero obsahu.
 * Použití: node test-auth.js <accessToken2> <refreshToken2>
 */
const fetch = require('node-fetch')

const GRAPHQL_URL = 'https://svc-prod.herohero.co/graphql/'
const [,, accessToken, refreshToken] = process.argv.map(a => a?.trim())

if (!accessToken || !refreshToken) {
    console.error('Použití: node test-auth.js <accessToken2> <refreshToken2>')
    process.exit(1)
}

const BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Origin': 'https://herohero.co',
    'Referer': 'https://herohero.co/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
}

const ASSETS_QUERY = `
query GetPostDetailPageQuery($id: ID!) {
  post(id: $id) {
    __typename
    id
    ... on CompleteContentPost {
      title
      assets {
        __typename
        ... on PostGjirafaAsset {
          hasVideo
          videoStreamUrl
          audioStaticUrl
        }
      }
    }
    ... on PreviewContentPost {
      title
    }
  }
}
`

// Testujeme obě epizody – tu co selhala ve Stremiu a tu co fungovala
const POST_IDS = [
    { id: 'zivotyslavnychilxmsrdorrvrcnmxpfcttgxmpwg', label: 'Epizoda ze Stremia (selhala)' },
    { id: 'zivotyslavnychilxmsrdordjfyqaopqrunerg',    label: 'Karel Marx (dřív fungovala)' }
]

function jwtExpiry(jwt) {
    try {
        const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
        const rem = p.exp - Math.floor(Date.now() / 1000)
        return rem > 0 ? `platí ještě ${rem}s` : `EXPIROVAL před ${-rem}s`
    } catch { return '?' }
}

async function gqlPost(postId, cookie) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { ...BASE_HEADERS, Cookie: cookie },
        body: JSON.stringify({
            operationName: 'GetPostDetailPageQuery',
            query: ASSETS_QUERY,
            variables: { id: postId }
        }),
        timeout: 15000
    })
    const sc = res.headers.get('set-cookie') || ''
    const newToken = sc.match(/accessToken2=([^;,\s]+)/)?.[1]
    const json = await res.json().catch(() => ({}))
    return { status: res.status, newToken, json }
}

async function main() {
    console.log('accessToken2:', jwtExpiry(accessToken))
    console.log('refreshToken2:', jwtExpiry(refreshToken))

    for (const { id, label } of POST_IDS) {
        console.log(`\n─── ${label} ───`)
        const cookie = `accessToken2=${accessToken}; refreshToken2=${refreshToken}`
        const { status, newToken, json } = await gqlPost(id, cookie)
        console.log('HTTP:', status)
        if (newToken) console.log('→ Nový accessToken2 přes Set-Cookie:', jwtExpiry(newToken))
        if (json.errors) console.log('Errors:', json.errors.map(e => e.message).join('; '))
        const post = json.data?.post
        if (post) {
            console.log('Typ:', post.__typename)
            if (post.title) console.log('Název:', post.title)
            if (post.assets?.length) {
                post.assets.forEach(a => console.log(`  hasVideo=${a.hasVideo} video=${a.videoStreamUrl?.substring(0,60)}`))
            }
        }
    }
}

main().catch(console.error)
