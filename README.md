# RiftScout

A simple League of Legends companion app for Windows: player profiles, ranked stats, match history and a live in-game view.

## Download

**[⬇ Download the latest version](https://github.com/Overthrow6981/riftscout/releases/latest)** – pick `RiftScout-Setup-x.y.z.exe`.

The app updates itself: when a new version is released it downloads in the background and asks you to restart.

> Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Click **More info → Run anyway**.

## First start

1. Get a free key at [developer.riotgames.com](https://developer.riotgames.com) (sign in → Development API Key).
2. Open RiftScout → **⚙ Settings** → paste the key → Save. (Development keys expire every 24 hours.)
3. Search any player by Riot ID (`Name#TAG`).

The **Live Game** tab works without a key – start a match (Practice Tool works) and it fills in automatically.

## Features

- Profile: icon, level, Solo/Flex rank, LP, win rate, top mastery
- Match history: champion, spells, runes, KDA, CS/min, kill participation, items, all 10 players (click a name to look them up)
- Summary of recent games: W/L, average KDA, best champions
- Live Game: both teams, KDA, CS, items, respawn timers, your gold, recent events

## Development

```
npm install
npm start          # desktop app (Electron)
npm run server     # web version only at http://localhost:3000
```

### Releasing an update
Bump `version` in `package.json` and push to `main`. GitHub Actions builds the installer and publishes the release; installed apps pick it up automatically.

---

RiftScout isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
