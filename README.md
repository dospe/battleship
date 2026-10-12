# Lodě

Klasické lodě v prohlížeči: solo proti počítači (tři obtížnosti), nebo dva
hráči v reálném čase přes sdílený odkaz na místnost. Bez účtů, bez reklam,
instalovatelné jako aplikace (PWA); hra proti počítači funguje i offline.

Fork projektu [Hackatoan/battleship](https://github.com/Hackatoan/battleship)
(Node.js + Express + Socket.io). Oproti původní hře:

- české rozhraní, bez patičky, odkazů, SEO textu a žebříčku,
- tmavý („Námořní“) a světlý („Papír“) vzhled s přepínačem vpravo nahoře,
- kódy polí (A1 … J10) na pozadí každého pole,
- potopené lodě zobrazené vlastní barvou (na obou deskách, i ve hře dvou hráčů),
- PWA (manifest, service worker, ikony), bez analytiky a Google přihlášení.

## Vývoj

```bash
npm install
npm start   # servíruje public/ + Socket.io na PORT (výchozí 3025)
```

Žádná databáze ani proměnné prostředí nejsou potřeba. Stav partií drží server
jen v paměti.

## Nasazení

Image staví GitHub Actions do `ghcr.io/dospe/battleship` při pushi do `main`.
Nasazení na VPS popisuje repozitář [dospe/lode](https://github.com/dospe/lode).

Při změně seznamu souborů v `PRECACHE` v `public/sw.js` zvyš i `VERSION`,
aby si nainstalovaná aplikace stáhla novou verzi.
