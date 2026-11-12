# How to Play SnowboardAnywhere

The short version for riders. No coding needed.

## Easiest way (Windows): download the zip

Nothing to install and no commands. You need about 1 GB of free space.

1. Open https://github.com/drewkeriazes/SnowboardAnywhere/releases/latest and download **SnowboardAnywhere-win.zip** (under Assets).
2. Right-click the downloaded zip > **Extract All** > **Extract**.
3. Open the folder it made (`SnowboardAnywhere-win`) and double-click **SnowboardAnywhere.exe**.
4. If Windows says **"Windows protected your PC"**: click **More info**, then **Run anyway**. The game isn't code-signed yet, so Windows warns about it once.
5. The first launch downloads Vail in a black window (about 270 MB, a few minutes). Then the game opens in your browser on the main menu.

Leave the black window open while you play. **Close it to quit.** More resorts: **Change resort** on the main menu.

**Playing again later:** double-click `SnowboardAnywhere.exe`. It starts straight away.

**Updating:** download the newest zip from the same page and extract it. Copy the `packs` folder from your old `SnowboardAnywhere-win` folder into the new one (replace the empty one), so you don't download your resorts again. Or close the black window and extract the new zip over the old folder. Settings and best times are kept by the browser, so they carry over.

| Problem | Fix |
| --- | --- |
| "Windows protected your PC" | Click **More info**, then **Run anyway**. |
| "The game folder is missing" | You opened the exe from inside the zip. Right-click the zip > **Extract All**, then open the exe in the extracted folder. |
| "Vail could not be downloaded" | Check your internet connection, then double-click the exe again. The download starts over. |
| "older than the published resorts" | Your copy is out of date. Download the newest zip (see Updating). |
| "Port 5173 was busy" | Something else uses that port. The game still opens on the next one, but settings and best times from 5173 don't show there. Close the other program and start again to get them back. |
| A resort says **Update** in **Change resort** after an update | Pick it: the game downloads the current version and swaps it in. If none of your resorts is current, the black window downloads Vail again when it starts. |
| A resort says **needs rebuild** | That resort isn't published for this version of the game yet: try again after its next release. A pack you built or copied in yourself says it too when it is out of date: rebuild it, or delete its folder from `packs` and download the published one. |
| The browser doesn't open, or it isn't Chrome or Edge | Paste the address the black window shows (like `http://localhost:5173/`) into Chrome or Edge. |

Everything else (controls, choppy game, no sound) is the same as below: see Basic controls and Troubleshooting.

---

## Developer, Mac or Linux way: Git and Node.js

Copy and paste a few commands. You need about 15 minutes and 1 GB of free space for the first setup.

### Step 1: Install two free programs (one time)

1. **Git** (downloads the game): https://git-scm.com/downloads
   Run the installer and click Next on every screen. The defaults are fine.
2. **Node.js** (runs the game): https://nodejs.org
   Get the **LTS** version. Click Next on every screen.

Then **restart your computer** (or at least close every terminal window) so it picks them up.

### Step 2: Open a terminal

- **Windows:** press the Windows key, type `cmd`, press Enter. (Use this, not PowerShell.)
- **Mac:** press Cmd + Space, type `Terminal`, press Enter.

Check that both programs installed. Type each line and press Enter:

```
git --version
node --version
```

You should see version numbers. If you see "not recognized" or "command not found", see Troubleshooting below.

### Step 3: Download the game (one time)

Copy and paste these, one line at a time:

```
cd %USERPROFILE%
git clone https://github.com/drewkeriazes/SnowboardAnywhere.git
cd SnowboardAnywhere\game
npm ci
```

On a Mac, use these instead of the first and third lines:

```
cd ~
cd SnowboardAnywhere/game
```

`npm ci` takes a minute or two. Warnings in yellow are normal.

### Step 4: Download a mountain (one time per resort)

Still in the same window:

```
npm run get vail
```

That downloads Vail (about 270 MB). Other resorts:

```
npm run get breckenridge
npm run get -- --list
```

The second line shows every resort you can download.

Skip this step if you like: the game's **Change resort** menu can download them too.

### Step 5: Play

```
npm run dev
```

Open **Chrome** or **Edge** and go to:

**http://localhost:5173/?pack=vail**

Click once on the page to turn on sound. Leave the terminal window open while you play.
To stop the game, click the terminal and press **Ctrl + C**.

### Playing again later (Git way)

Open a terminal and run:

```
cd %USERPROFILE%\SnowboardAnywhere\game
git pull
npm ci
npm run dev
```

(Mac: first line is `cd ~/SnowboardAnywhere/game`.)

`git pull` grabs the newest version of the game. Then open http://localhost:5173/?pack=vail again.

If **Change resort** shows **Update** next to your resort, pick it, or download it again. Either way it swaps in the new version on its own:

```
npm run get vail
```

**needs rebuild** means that resort isn't published for this version of the game yet (or it is a pack you built yourself in an older format).

If it says **needs a newer game**, you skipped `git pull`. Run it, then start again.

---

## Basic controls

| Keyboard | Controller | What it does |
| --- | --- | --- |
| A / D | left stick | steer |
| W | R2 / RT | tuck (go faster) |
| S | L2 / LT | brake |
| Space (hold, let go) | Cross / A | jump |
| Shift | Square / X | carve hard, grab in the air |
| E | Triangle / Y | ride a lift |
| M | D-pad right | map (click to drop in anywhere) |
| C | D-pad up | change camera |
| R (hold) | | restart |
| Esc | Options / Start | pause and settings |

Plug in a PlayStation or Xbox controller and press any button with the game open. It just works.

The full list of controls is in the main [README](README.md#controls).

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `'git' is not recognized` or `'node' is not recognized` | Restart your computer after installing. Still broken? Reinstall from Step 1. |
| `npm.ps1 cannot be loaded because running scripts is disabled` | You are in PowerShell. Close it and open **cmd** instead (Step 2). |
| `npm ERR! enoent ... package.json` | You are in the wrong folder. Run `cd %USERPROFILE%\SnowboardAnywhere\game` first (Mac: `cd ~/SnowboardAnywhere/game`). |
| `destination path 'SnowboardAnywhere' already exists` | You already downloaded it. Skip to "Playing again later". |
| Page says "This site can't be reached" | The game isn't running. Run `npm run dev` and keep that window open. |
| Terminal says a different address, like `localhost:5174` | Something else is using the port. Use the address the terminal shows. |
| Menu loads but no mountain, or "pack not found" | Download it: `npm run get vail`. |
| Game opens on **No resorts yet** | You have no resort yet. Pick one in the list to download it, or run `npm run get vail` and reload. |
| Download stops partway | Run the same `npm run get` line again. |
| Game is choppy | Esc > Settings > Graphics > pick **Low** or **Medium**. Close other tabs. |
| No sound | Click the page once. Browsers wait for a click before playing sound. |
| Controller not working | Press a button while the game tab is in front. Use Chrome or Edge. |
| Something else | Close the terminal, open a new one, and start again from "Playing again later". |

Still stuck? Copy the red error text from the terminal and send it to Drew.
