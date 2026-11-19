# RiftScout

A League of Legends companion app for Windows – like Blitz, but simple:

- **Builds & runes** for every champion and role, calculated from Challenger, Grandmaster and Master ranked games: rune page, summoner spells, skill order, starting items, boots, core build and 4th–6th item options, with win and pick rates.
- **Champ select auto-import:** lock in a champion and RiftScout puts the rune page and an item set straight into your League client (spells with one click).
- **In-game overlay:** next item to buy, "Level up" reminder, KDA, CS/min and gold on top of the game (Borderless or Windowed mode; Ctrl+Shift+O hides it).
- **Profiles & match history:** rank, LP, mastery and recent games for any Riot ID.
- **Live game view** of both teams.

## Download

**[⬇ Download the latest version](https://github.com/Overthrow6981/riftscout/releases/latest)** – pick `RiftScout-Setup-x.y.z.exe`.

The app updates itself: when a new version is released it downloads in the background and asks you to restart.

> Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Click **More info → Run anyway**.

## First start

1. Get a free key at [developer.riotgames.com](https://developer.riotgames.com) (sign in → Development API Key).
2. Open RiftScout → **⚙ Settings** → paste the key → Save. (Development keys expire every 24 hours.)
3. Keep RiftScout open: it collects high-elo games in the background and the **Builds** tab fills up. Popular champions are ready first.

## Shared build data (for the repo owner)

The workflow `.github/workflows/collect-builds.yml` collects games every 4 hours and publishes `builds.json` in the **build-data** release. Every RiftScout app downloads it, so builds work immediately – even without an own API key.

It needs a repository secret **`RIOT_API_KEY`** (Settings → Secrets and variables → Actions). A Development key expires after 24 hours; a **Personal API Key** (developer.riotgames.com → Register Product → Personal API Key) does not expire.

## Development

```
npm install
npm start          # desktop app (Electron)
npm run server     # web version only at http://localhost:3000
npm run collect -- --region na1 --minutes 30   # collect build data (needs RIOT_API_KEY)
```

### Releasing an update
Bump `version` in `package.json` and push to `main`. GitHub Actions builds the installer and publishes the release; installed apps pick it up automatically.

---

RiftScout isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
