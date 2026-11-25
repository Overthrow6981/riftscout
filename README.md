# RiftScout

A League of Legends companion app for Windows – like Blitz, but simple. **No API key needed:** RiftScout reads your profile, match history and lobby from the League client on your PC.

- **Builds & runes** for every champion and role, calculated from Challenger, Grandmaster and Master ranked games on every server (EUW, NA, KR, EUNE, BR, LAN, LAS, OCE, TR, RU, JP, ME, SEA, TW, VN): rune page, summoner spells, skill order, starting items, boots, core build and 4th–6th item options, with win and pick rates.
- **Matchups:** builds, runes, spells and skill order *against your lane opponent*, matchup win rates, "strong against" / "weak against" lists and counter picks.
- **Champ select:** see the enemy picks as they lock in, which one is your lane opponent (click another enemy if the guess is wrong), and a ranked list of the best picks for your role against them with **Game %** (wins the game) and **Lane %** (ahead in gold at 15 minutes) – click one for its runes and build in that matchup. Before the enemy picks you see the strongest picks for your role.
- **Full rune pages** like in the client: every option in both trees and the stat shards, with the chosen ones lit up.
- **Runes instantly, always:** when RiftScout's own stats for a champion aren't in yet, it imports Riot's recommended rune page and spells from the League client.
- **Champ select auto-import:** RiftScout jumps to the front when champ select starts. As soon as you pick a champion it puts the rune page, item set and summoner spells straight into your League client – no clicks needed. If all your rune pages are full it replaces the current one (like Blitz; you can turn this off) – but first it saves a backup of that page, which you can put back under Settings → Backups. If the enemy laner picks after you, the matchup runes are imported automatically. Every champion gets an item set in the in-game shop. With 10+ high-elo games in the role it is the champion's own build. With fewer, RiftScout uses the champion's own games from other roles (items barely change between roles), topped up with the champions whose item builds are closest to it; starting items always come from the role itself. Like Blitz, the shop gets up to 3 builds to choose from: the main one, plus other core builds that are played often enough, each named after the item that makes it different ("RiftScout Jinx: Lord Dominik's build"). In champ select the item sets are written the same way Blitz does it: as a file in League's shop folder (`Config\Global\Recommended`), marked so the shop lists it first, and taken out again after the game (or when champ select ends without a game). Blitz leaves its own set files behind when it is closed before it can clean up – that is why "Blitz: …" sets can keep showing in the shop even when Blitz isn't running. RiftScout moves those leftovers out of the shop into a backup folder in its own data folder (nothing is deleted; Settings → Backups puts any of them back exactly where it was). It only touches item-set files whose name starts with `blitz-` or `blitz_` (also with `!!!` in front, like Blitz's `!!!blitz-0.json`) or whose title starts with "Blitz" followed by `:`, `-`, `–` or `|` (so "Blitzcrank …" or "Blitz build" are left alone); folders and links are never touched. If the Blitz app is also running, RiftScout shows a warning with a "Close Blitz" button and switches back to its own rune page if Blitz picks its page during champ select (you can turn all of this off in Settings). After a League patch, items, runes and spells that Riot removed are never recommended, even while the build data still has older games with them (RiftScout checks against the newest Data Dragon). A GitHub workflow ("Patch check") also checks every 6 hours that everything RiftScout reads from League still matches the newest patch and writes a report per patch as a GitHub issue. Settings → Recent activity shows exactly what RiftScout did in champ select (also written to riftscout.log in RiftScout's data folder). Tested against the real data by hiding each well-known champion's games in a role: the core items it picks are items that champion really buys about 74% of the time (the simple "same class" approach managed 35%).
- **Lobby scouting:** from the loading screen on, all 10 players with rank, win rate, level and mastery on the champion they picked, plus tags like *One-trick*, *First time on champ*, *Hot streak* and *Possible smurf*. Your lane opponent is highlighted. In champ select you see your own team (Riot hides names in ranked champ select, and RiftScout respects that).
- **Profiles & match history:** rank, LP, mastery and recent games for any player on your server (any server with an optional Riot API key).
- **Knows who you are:** with the League client open, RiftScout picks up your Riot ID and server by itself and opens your profile — no typing. It remembers them for when League is closed.
- **Live game view** of both teams, with "Item value by lane": for every lane your champion against the enemy one, with the shop value of the items each holds right now, CS and KDA, plus the team total. This is not total gold: unspent gold, sold items and used consumables don't count (Riot's live game API doesn't give apps other players' gold). Lanes come from the game, from champ select for your own team, or are guessed (Smite = jungle) and marked "? guessed".
- **Honest numbers:** every recommendation's win rate comes with its number of games; win rates from fewer than 30 games are shown grey with a * and are never coloured as good or bad. The build page shows the patch, where the data comes from (high-elo ranked solo games on Summoner's Rift) and when the newest game was added, and warns when the data is from an older patch or hasn't had new games for 3 days. Fallbacks (Riot's recommended runes, items from similar champions) are labelled, and in ARAM RiftScout says that its runes come from Summoner's Rift data.

## Download

**[⬇ Download the latest version](https://github.com/Overthrow6981/riftscout/releases/latest)** – pick `RiftScout-Setup-x.y.z.exe`.

The app updates itself: when a new version is released it downloads in the background and asks you to restart.

> Windows may show "Windows protected your PC" because the installer isn't code-signed yet. Click **More info → Run anyway**.

## First start

1. Install and open RiftScout.
2. Open the League client. RiftScout picks up your Riot ID and server and shows your profile – nothing to type, no key.

**Optional:** a Riot API key (Settings) lets you search players on other servers and collect extra build data on your own PC.

## Shared build data (for the repo owner)

The workflow `.github/workflows/collect-builds.yml` collects games every 4 hours and publishes `builds.json` in the **build-data** release. Every RiftScout app downloads it, so builds work immediately – even without an own API key.

It needs a repository secret **`RIOT_API_KEY`** (Settings → Secrets and variables → Actions).

Which key: Riot's developer portal ([docs/portal](https://developer.riotgames.com/docs/portal)) says development keys deactivate every 24 hours and may not be used to maintain a public product, a personal key may not be used to run an app for public consumption, and public products need a registered product with a Production key (Riot reviews the product first). Because every RiftScout install downloads this data, check with Riot which key applies before a public release. Never put the key in the app or in the repository – only in the secret.

Every run writes `build-status.json` to the same release (last run, last run with new games, newest game, and the error such as `key_invalid`). `builds.json` is only re-uploaded when the run added new games, so its timestamps never look fresh without new data. The app and the "Patch check" issue show when the key has stopped working; the run itself stays red so GitHub e-mails the owner.

## Development

```
npm install
npm start          # desktop app (Electron)
npm run server     # web version only at http://localhost:3000
npm run collect -- --region na1 --minutes 30   # collect build data (needs RIOT_API_KEY)
npm test           # automated tests (build data, server security and error handling)
```

### Releasing an update
Bump `version` in `package.json` and push to `main`. GitHub Actions builds the installer and publishes the release; installed apps pick it up automatically.

---

RiftScout isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
