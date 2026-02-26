# HeroHero Stremio Addon

Neoficiální addon pro [Stremio](https://www.stremio.com/), který umožňuje přehrávat videa a podcasty z [HeroHero](https://herohero.co/) přímo v přehrávači – bez nutnosti otevírat prohlížeč.

---

## Použití

Addon běží na veřejném serveru. Stačí ho nakonfigurovat a nainstalovat do Stremia:

**➜ [Otevřít konfiguraci](https://stremio-herohero-addon.onrender.com/configure)**

Nepotřebuješ nic instalovat ani spouštět lokálně.

---

## Jak nastavit

### 1. Získej Refresh Token

Token slouží pro přihlášení k HeroHero a přístup k videím. Bez něj addon zobrazí pouze audio z RSS feedu.

1. Přihlas se na [herohero.co](https://herohero.co/)
2. Otevři DevTools — `F12` na Windows/Linux, `Cmd+Option+I` na Mac
3. Záložka **Application** → **Cookies** → `https://herohero.co`
4. Zkopíruj hodnotu cookie **`refreshToken2`**

### 2. Načti předplatné a instaluj

1. Otevři [konfiguraci addonu](https://stremio-herohero-addon.onrender.com/configure)
2. Vlož Refresh Token a klikni **Načíst předplatné**
3. U každého kanálu, který chceš sledovat, vlož jeho **RSS URL** (viz níže) a klikni **Instalovat**
4. Stremio se otevře a addon se přidá automaticky

### Kde najít RSS URL kanálu

RSS URL je unikátní pro každé předplatné a obsahuje tvůj přihlašovací token. Formát:

```
https://svc-prod-na.herohero.co/rss-feed/?token=...
```

Najdeš ji v e-mailu od HeroHero po aktivaci předplatného, nebo v nastavení svého účtu na herohero.co.

---

## Co addon umí

- Přehrávání **videa** (HLS) i **audia** (MP3 320 kbps)
- Automatická obnova přihlašovacích tokenů na pozadí
- Při chybějícím tokenu fallback na audio z RSS feedu
- Funguje ve Stremiu na desktopu i ve [webové verzi](https://web.stremio.com/)
- **Vlastní plakát** – každý kanál zobrazuje v konfiguraci volitelné pole pro URL vlastního obrázku, který nahradí výchozí obrázek z RSS feedu. Hodí se, protože Stremio zobrazuje obsah ve formátu `poster` (knižní orientace), zatímco HeroHero používá čtvercové nebo horizontální obrázky.

---

## Disclaimer

Neoficiální projekt, není spojen s HeroHero. Slouží výhradně pro přehrávání obsahu, ke kterému má uživatel legitimní přístup prostřednictvím aktivního předplatného.

## Licence

MIT
