const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const { fetchFeed } = require('./lib/rss')
const { getPostAssets, getSubscriptions } = require('./lib/herohero')

const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${process.env.PORT || 7070}`).replace(/\/$/, '')

const manifest = {
    id: 'community.herohero.rss',
    version: '1.0.0',
    name: 'HeroHero',
    description: 'Přehrávej video a audio obsah z HeroHero',

    // Oznamujeme, jaké resources addon poskytuje.
    // meta a stream omezíme na typ 'channel' a naše ID prefix,
    // aby Stremio neposílal dotazy pro cizí obsah.
    resources: [
        'catalog',
        { name: 'meta',   types: ['series'], idPrefixes: ['herohero:'] },
        { name: 'stream', types: ['series'], idPrefixes: ['herohero:'] }
    ],
    types: ['series'],
    catalogs: [
        {
            type: 'series',
            id: 'herohero_rss',
            name: 'HeroHero'
        }
    ],

    behaviorHints: {
        configurable: true,
        configurationRequired: true,
        configurationURL: ADDON_URL + '/configure'
    },
    config: [
        {
            key: 'rssUrl',
            type: 'text',
            title: 'URL RSS feedu',
            required: true
        },
        {
            key: 'refreshToken',
            type: 'password',
            title: 'HeroHero Refresh Token – cookie "refreshToken2" z DevTools → Application → Cookies → herohero.co (platí 30 dní)',
            required: false
        },
        {
            key: 'posterImage',
            type: 'text',
            title: 'Vlastní URL obrázku kanálu (volitelné – přepíše obrázek z RSS)',
            required: false
        }
    ]
}

const builder = new addonBuilder(manifest)

// ---------------------------------------------------------------------------
// CATALOG – vrátí jednu "kartu" představující celý kanál/show
// ---------------------------------------------------------------------------
builder.defineCatalogHandler(async ({ type, id, config }) => {
    console.log(`[catalog] type=${type} id=${id} rssUrl=${config?.rssUrl ? 'OK' : 'CHYBÍ'} refreshToken=${config?.refreshToken ? 'OK' : 'chybí'}`)

    if (type !== 'series' || id !== 'herohero_rss') {
        return { metas: [] }
    }

    const rssUrl = config?.rssUrl
    if (!rssUrl) {
        console.warn('[catalog] rssUrl chybí v konfiguraci!')
        return { metas: [] }
    }

    let feed
    try {
        feed = await fetchFeed(rssUrl)
    } catch (err) {
        console.error('[catalog] Chyba při načítání feedu:', err.message)
        return { metas: [] }
    }

    const poster = config?.posterImage?.trim() || feed.image

    return {
        metas: [
            {
                id: 'herohero:channel',
                type: 'series',
                name: feed.title,
                poster,
                posterShape: 'poster',
                description: feed.description
            }
        ],
        cacheMaxAge: 3600,
        staleRevalidate: 86400,
        staleError: 604800
    }
})

// ---------------------------------------------------------------------------
// META – podrobnosti o kanálu + seznam všech epizod
// ---------------------------------------------------------------------------
builder.defineMetaHandler(async ({ type, id, config }) => {
    if (type !== 'series' || !id.startsWith('herohero:')) {
        return { meta: null }
    }

    const rssUrl = config?.rssUrl
    if (!rssUrl) return { meta: null }

    let feed
    try {
        feed = await fetchFeed(rssUrl)
    } catch (err) {
        console.error('[meta] Chyba při načítání feedu:', err.message)
        return { meta: null }
    }

    const videos = feed.episodes.map(ep => ({
        id: `herohero:${ep.guid}`,
        title: ep.title,
        released: ep.pubDate,
        thumbnail: ep.image || feed.image,
        overview: ep.description || ''
    }))

    const poster = config?.posterImage?.trim() || feed.image

    return {
        meta: {
            id: 'herohero:channel',
            type: 'series',
            name: feed.title,
            poster,
            posterShape: 'poster',
            description: feed.description,
            videos
        },
        cacheMaxAge: 3600,
        staleRevalidate: 86400,
        staleError: 604800
    }
})

// ---------------------------------------------------------------------------
// STREAM – URL video/audio souboru pro konkrétní epizodu
// ---------------------------------------------------------------------------
builder.defineStreamHandler(async ({ type, id, config }) => {
    if (type !== 'series' || !id.startsWith('herohero:')) {
        return { streams: [] }
    }

    const episodeGuid = id.slice('herohero:'.length)
    if (!episodeGuid || episodeGuid === 'channel') {
        return { streams: [] }
    }

    const { rssUrl, accessToken, refreshToken } = config ?? {}
    console.log(`[stream] guid=${episodeGuid} refreshToken=${refreshToken ? 'OK' : 'chybí'}`)
    const streams = []

    // --- Cesta 1: GraphQL API (vyžaduje refreshToken) → video HLS + audio MP3 ---
    if (refreshToken) {
        try {
            const assets = await getPostAssets(episodeGuid, accessToken || '', refreshToken)
            console.log(`[stream] GraphQL assets: ${assets.length}, hasVideo: ${assets.map(a => a.hasVideo).join(',')}`)
            for (const asset of assets) {
                // Video HLS stream (master playlist)
                if (asset.hasVideo && asset.videoStreamUrl) {
                    streams.push({
                        url: asset.videoStreamUrl,
                        name: 'Video',
                        description: 'HLS video stream'
                    })
                }
                // Audio MP3 jako záloha (vždy přítomný)
                if (asset.audioStaticUrl) {
                    streams.push({
                        url: asset.audioStaticUrl,
                        name: 'Audio',
                        description: 'MP3 320 kbps',
                        behaviorHints: {
                            notWebReady: true,
                            filename: sanitizeFilename(episodeGuid) + '.mp3'
                        }
                    })
                }
            }
        } catch (err) {
            console.error('[stream] GraphQL chyba:', err.message)
        }
    }

    // --- Cesta 2: Fallback na RSS enclosure URL (audio only) ---
    if (streams.length === 0 && rssUrl) {
        try {
            const feed = await fetchFeed(rssUrl)
            const episode = feed.episodes.find(ep => ep.guid === episodeGuid)
            if (episode?.enclosureUrl) {
                const s = {
                    url: episode.enclosureUrl,
                    name: 'Audio (RSS)',
                    description: episode.title,
                    behaviorHints: {
                        notWebReady: true,
                        filename: sanitizeFilename(episode.title) + '.mp3'
                    }
                }
                if (episode.enclosureLength > 0) s.behaviorHints.videoSize = episode.enclosureLength
                streams.push(s)
            }
        } catch (err) {
            console.error('[stream] RSS fallback chyba:', err.message)
        }
    }

    return {
        streams,
        cacheMaxAge: 300,       // 5 minut – URL jsou podepisované a mohou expirovat
        staleRevalidate: 600,
        staleError: 3600
    }
})

// ---------------------------------------------------------------------------
// Start serveru
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
    return name
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100)
}


// ---------------------------------------------------------------------------
// Konfigurační stránka (HTML)
// ---------------------------------------------------------------------------
function getConfigurePage(baseUrl) {
    return `<!DOCTYPE html><html lang="cs"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HeroHero – Konfigurace</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e5e5e5;padding:1.5rem 1rem}
.w{max-width:780px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:1.5rem;color:#fff}
.card{background:#181818;border:1px solid #252525;border-radius:8px;padding:1.2rem;margin-bottom:1.5rem}
h2{font-size:.78rem;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem}
label{display:block;margin-bottom:.9rem}
label span{display:block;font-size:.77rem;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.25rem}
input[type=url],input[type=password]{width:100%;padding:.55rem .8rem;border:1px solid #252525;border-radius:5px;background:#111;color:#fff;font-size:.9rem}
input:focus{outline:none;border-color:#7c3aed}
.hint{font-size:.72rem;color:#444;margin-top:.2rem}
.btn{display:inline-flex;align-items:center;padding:.6rem 1.2rem;border:none;border-radius:5px;font-size:.88rem;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn-primary{background:#7c3aed;color:#fff}.btn-primary:hover{background:#6d28d9}
.btn-sm{padding:.38rem .85rem;font-size:.8rem}
.btn-green{background:#059669;color:#fff}.btn-green:hover{background:#047857}
.status{font-size:.82rem;margin-top:.6rem;min-height:1.2em}
.err{color:#f87171}.ok{color:#6ee7b7}
table{width:100%;border-collapse:collapse;margin-top:.3rem}
th{text-align:left;font-size:.72rem;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.05em;padding:.35rem .5rem;border-bottom:1px solid #252525}
td{padding:.45rem .5rem;border-bottom:1px solid #1a1a1a;vertical-align:middle}
.sub-name{font-size:.88rem;font-weight:600;white-space:nowrap;padding-right:.8rem}
td input{padding:.4rem .65rem;font-size:.8rem}
.result-row td{background:#0d0d0d;padding:.65rem .5rem}
.res-box{display:flex;gap:.5rem;align-items:center}
.res-box input{flex:1;font-size:.76rem;color:#777}
#subs-card{display:none}
</style></head><body><div class="w">
<h1>HeroHero – Konfigurace</h1>
<div class="card">
  <h2>Přihlašovací údaje</h2>
  <label><span>Refresh Token</span><input type="password" id="rt" placeholder="eyJ…"><p class="hint">Cookie „refreshToken2" z DevTools → Application → Cookies → herohero.co (platí 30 dní)</p></label>
  <button class="btn btn-primary" id="fetchBtn">Načíst předplatné</button>
  <p id="st" class="status"></p>
</div>
<div class="card" id="subs-card">
  <h2>Aktivní předplatné</h2>
  <table><thead><tr><th>Pořad</th><th>RSS URL *</th><th>Vlastní poster (volitelné)</th><th></th></tr></thead>
  <tbody id="sb"></tbody></table>
</div>
</div><script>
const BASE='${baseUrl}',LS='hh_cfg'
function gs(){try{return JSON.parse(localStorage.getItem(LS)||'{}')}catch{return{}}}
function ss(k,v){try{const s=gs();s[k]=v;localStorage.setItem(LS,JSON.stringify(s))}catch(e){}}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function st(msg,cls){const e=document.getElementById('st');e.textContent=msg;e.className='status '+(cls||'')}

// Obnov tokeny z localStorage nebo URL
const saved=gs()
if(saved.rt)document.getElementById('rt').value=saved.rt
const m=location.pathname.match(/^\\/([^/]+)\\/configure$/)
if(m)try{const c=JSON.parse(decodeURIComponent(m[1]));if(c.refreshToken)document.getElementById('rt').value=c.refreshToken}catch(e){}
if(saved.subs)renderSubs(saved.subs)

async function fetchSubs(){
  const btn=document.getElementById('fetchBtn')
  const rt=document.getElementById('rt').value.trim()
  if(!rt){st('Vyplň Refresh Token.','err');return}
  ss('rt',rt)
  btn.disabled=true;btn.textContent='Načítám…'
  st('')
  try{
    const r=await fetch(BASE+'/api/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:rt})})
    const text=await r.text()
    let d;try{d=JSON.parse(text)}catch(e){throw new Error('Server: '+text.substring(0,200))}
    if(d.error){st(d.error,'err');return}
    ss('subs',d.subscriptions)
    renderSubs(d.subscriptions)
    st(d.subscriptions.length+' předplatných načteno.','ok')
  }catch(e){st('Chyba: '+e.message,'err')}
  finally{btn.disabled=false;btn.textContent='Načíst předplatné'}
}
document.getElementById('fetchBtn').addEventListener('click',fetchSubs)

function renderSubs(subs){
  if(!subs||!subs.length){st('Žádné aktivní předplatné.','err');return}
  const rss=gs().rss||{},pos=gs().pos||{}
  const tb=document.getElementById('sb')
  tb.innerHTML=''
  subs.forEach(function(sub){
    const id=sub.slug||sub.id
    const tr=document.createElement('tr')
    tr.innerHTML=\`<td class="sub-name">\${esc(sub.name)}</td><td><input type="url" id="rss-\${esc(id)}" value="\${esc(rss[id]||'')}" placeholder="https://svc-prod-na.herohero.co/rss-feed/?token=\u2026" oninput="saveRss('\${esc(id)}',this.value)"></td><td><input type="url" id="pos-\${esc(id)}" value="\${esc(pos[id]||'')}" placeholder="https://\u2026" oninput="savePos('\${esc(id)}',this.value)"></td><td><button class="btn btn-sm btn-green" onclick="install('\${esc(id)}','\${esc(sub.name)}')">Instalovat</button></td>\`
    tb.appendChild(tr)
    const rr=document.createElement('tr')
    rr.id='rr-'+id
    rr.className='result-row'
    rr.style.display='none'
    rr.innerHTML=\`<td colspan="4"><div class="res-box"><input id="mu-\${esc(id)}" readonly onclick="this.select()"><a id="sl-\${esc(id)}" class="btn btn-sm btn-green" href="#">Otevřít ve Stremiu</a></div></td>\`
    tb.appendChild(rr)
  })
  document.getElementById('subs-card').style.display='block'
}

function saveRss(id,v){const s=gs();s.rss=s.rss||{};s.rss[id]=v;try{localStorage.setItem(LS,JSON.stringify(s))}catch(e){}}
function savePos(id,v){const s=gs();s.pos=s.pos||{};s.pos[id]=v;try{localStorage.setItem(LS,JSON.stringify(s))}catch(e){}}

function install(id,name){
  const rssUrl=(document.getElementById('rss-'+id)||{}).value
  if(!rssUrl||!rssUrl.trim()){alert('Vyplň RSS URL pro: '+name);return}
  const rt=document.getElementById('rt').value.trim()
  const poster=(document.getElementById('pos-'+id)||{}).value
  const cfg={rssUrl:rssUrl.trim()}
  if(rt)cfg.refreshToken=rt
  if(poster&&poster.trim())cfg.posterImage=poster.trim()
  const enc=encodeURIComponent(JSON.stringify(cfg))
  const mu=BASE+'/'+enc+'/manifest.json'
  const sl=mu.replace(/^https?:\\/\\//, 'stremio://')
  document.getElementById('mu-'+id).value=mu
  document.getElementById('sl-'+id).href=sl
  const rr=document.getElementById('rr-'+id)
  rr.style.display=''
  rr.scrollIntoView({behavior:'smooth',block:'nearest'})
}
</script></body></html>`
}

const PORT = process.env.PORT || 7070
const app = express()

// CORS pro všechny routy (Stremio webview to vyžaduje)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
})

// Root → přesměruj na konfiguraci
app.get('/', (req, res) => res.redirect('/configure'))

// Konfigurační stránka – /configure i /:config/configure (pro pre-fill z URL)
app.get(['/configure', '/:config/configure'], (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(getConfigurePage(ADDON_URL))
})

// API – seznam aktivních předplatných
app.post('/api/subscriptions', (req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { body = {} }
        const { refreshToken } = body || {}
        if (!refreshToken) {
            return res.json({ error: 'Chybí refreshToken' })
        }
        try {
            const subs = await getSubscriptions('', refreshToken)
            res.json({ subscriptions: subs })
        } catch (err) {
            res.json({ error: err.message })
        }
    })
})

// SDK addon router (manifest, catalog, meta, stream)
app.use(getRouter(builder.getInterface()))

const server = app.listen(PORT, () => {
    console.log(`HeroHero RSS addon běží na http://localhost:${PORT}`)
    console.log(`Konfigurace:  ${ADDON_URL}/configure`)
    console.log(`Manifest:     http://localhost:${PORT}/manifest.json`)
})

server.on('request', (req) => {
    console.log(`→ ${req.method} ${req.url}`)
})
