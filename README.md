# Car Karaoke

Karaoke-style synced lyrics for the Tesla in-car browser. It is a static site (three files, no server) that you host free on GitHub Pages.

## What it does

The app keeps the highlighted lyric in time with the music in one of three ways:

| Mode | How it knows the song | How it knows where you are in the song | What you need |
|---|---|---|---|
| **Manual** | You search for it | You tap the line being sung (or press Start when the song begins), then nudge if needed | Nothing |
| **Spotify** (hands-free) | Your Spotify account's "currently playing" track, checked every ~4 seconds | Spotify's reported position, smoothed by the app's own clock | Spotify Premium and a free Spotify developer app (about 5 minutes) |
| **Listen** | A 6–10 second clip from the cabin microphone, identified by AudD | AudD reports where in the song the clip came from | Tesla software 2026.26 or newer and an AudD token (300 free IDs, then pay as you go) |

Lyrics come from LRCLIB, a free lyrics database with time-stamped (LRC) lyrics for most popular songs.

---

## Research findings (checked 4 November 2026)

**Confirmed** means a primary or first-hand source says so. **Likely** means good indirect evidence. **Unknown** means it has to be tested in your car.

### 1. Can a web page hear the car's media audio?

- **Confirmed: no direct access.** Spotify, radio and Bluetooth play in the car's own media system, outside the browser, and no web API exposes that audio to a page.
- **Confirmed: the microphone works since software 2026.26.** The Summer Update lets websites ask for the cabin microphone (and the interior camera, parked only), with an on-screen prompt to approve each request. It is limited to AMD Ryzen cars. A 2026 Model Y has the Ryzen computer, so yours should have it. Before this update, `getUserMedia` was blocked inside the browser itself.
- **Unknown: how well the mic hears the music.** The mic is tuned for voice, and the car may cancel its own speaker output from the mic signal, the way phones do on calls. The app asks for raw audio (echo cancellation off) and includes a mic test meter so you can check this in two minutes.

### 2. Can the page see what the car is playing?

- **Confirmed: not through the browser.** The Media Session API only lets a page announce its *own* audio. Nothing in the browser exposes the car's now-playing information.
- **Likely: yes through Spotify's Web API.** The car's Spotify app runs on Spotify's own service, so your account's "currently playing" endpoint reports the car's track and position. A Tesla owner on the MacRumors forums describes running exactly this kind of lyrics page on the center screen, and a commercial Tesla karaoke site (Belter) is built on Spotify login.
- **Confirmed: Spotify's 2026 developer rules apply.** Since February/March 2026, a developer-mode app needs the owner to have **Spotify Premium** (it stops working if Premium lapses) and allows up to **5 users**. The player endpoints this app uses were not on the removed list.
- **Confirmed: no equivalent for Apple Music, TuneIn or FM radio.** For those, use Listen or Manual.

### 3. Speech recognition (Web Speech API)

- **Likely unavailable in the car.** Tesla's browser is built on QtWebEngine (embedded Chromium). Chrome's speech recognition relies on a Google service that embedded Chromium builds generally don't include, and Qt users report it doesn't work there.
- **Likely not useful anyway.** Speech recognizers are built for spoken voice. Sung vocals over a full mix are a poor fit for picking out the current line.
- The app doesn't depend on it. Settings → "What this browser supports" shows whether your car has it.

### 4. Lyrics sources

| Source | Synced (LRC) lyrics? | Free? | API key? | Works from a browser? | Notes |
|---|---|---|---|---|---|
| **LRCLIB** (used) | Yes, plus plain text | Yes | No | **Yes**, CORS enabled | Community database. About 45 requests/min for anonymous browser clients, plenty for this app |
| **Musixmatch** | Paid plans only | Free plan returns only **30%** of each song's lyrics | Yes | Key should be kept on a server | The licensed provider behind Spotify's lyrics; needs a commercial agreement |
| **Genius** | No | Yes | Yes | n/a | The official API **does not return lyric text**, only song info and a page link |

### 5. Identifying a song from a short clip

| Option | Practical? | Notes |
|---|---|---|
| **AudD** (used) | **Yes** | Send a short clip, get artist, title and a **timecode** (where in the song the clip was), typically in 0.1–1.5 s. 300 free requests at signup, then about US$5 per 1,000. **Unknown:** whether AudD accepts requests directly from a browser (I couldn't test it). The included `worker.js` is a free fallback proxy |
| **ACRCloud** | Not without a server | 14-day free trial, then paid. Requests are signed with a secret key, which shouldn't live in a web page |
| **AcoustID / Chromaprint** | **Likely not** | Built to identify whole audio files, not noisy 10-second clips recorded in a cabin |

### 6. Keeping lyrics in sync for the whole song

This is a design question rather than a platform one. The approach the app uses:

- **Timestamped LRC lyrics plus a playback clock.** The clock runs on its own between updates, so lyrics move smoothly even if updates are seconds apart.
- **Spotify mode:** every poll compares Spotify's position with the clock. A gap over 1 second means you skipped or seeked, so the clock jumps. Smaller gaps are corrected halfway each poll, so it never jitters. Polling speeds up near the end of a song to catch the next track quickly.
- **Pauses, ads, podcasts:** the clock pauses and a message shows. Lyrics resume on the next song.
- **Tap to sync:** tap the line being sung. The app assumes you tapped about 0.3 s late (normal reaction time).
- **Nudge buttons:** ±0.5 s. In Spotify mode the correction is **saved** because it mostly reflects a constant delay between Spotify's reported position and what comes out of the speakers.
- **Listen re-anchoring:** tap Listen again mid-song to re-sync. AudD's timecode is in whole seconds, so expect ±1 s and nudge.
- **Plain lyrics (no timestamps):** lines are spread evenly over the song. Each line you tap pins that line's time, and the rest are re-fitted between your taps.

### Sources

- Tesla 2026.26 browser mic and camera: <https://www.notateslaapp.com/news/4621/tesla-adds-bookmark-syncing-larger-content-full-screen-video-and-camera-support-to-browser-in-202626-update>
- Tesla browser capability probe (QtWebEngine, mic blocked before 2026.26): <https://github.com/madpowah/tesla-video-drive>
- Spotify developer-mode changes: <https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide> and <https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security>
- Spotify-driven lyrics on a Tesla screen: <https://forums.macrumors.com/threads/porsche-taycan-gains-apple-podcasts-and-apple-music-time-synced-lyrics.2262474/page-2> and <https://belter.pages.dev/>
- Web Speech API: <https://developer.mozilla.org/docs/Web/API/Web_Speech_API>; QtWebEngine report: <https://forum.qt.io/topic/121291/cannot-use-webrtc-audiocapture-with-webengineview-connected-to-local-server-via-webkitspeechrecognition>
- LRCLIB API: <https://lrclib.net/docs>
- Musixmatch free tier: <https://freeapihub.com/apis/musixmatch>
- Genius API (no lyric text): <https://apis.io/providers/genius/>
- AudD: <https://docs.audd.io/> and <https://audd.io/>
- ACRCloud trial: <https://docs.acrcloud.com/tutorials/recognize-music>

---

## How it works

```
 Where the song is ("position source", one at a time)
   Manual   you tap a line, or press Start ─────┐
   Spotify  currently-playing, every ~4 s ──────┼──►  playback clock ──► + timing correction ──► highlighted line
   Listen   mic clip → AudD timecode ───────────┘     (ticks on its own)

 Which lyrics
   LRCLIB exact match (title + artist + album + duration)
     └─ if not found: fuzzy search, best match by title, artist, duration, synced first
     └─ last 40 songs cached in the browser, so repeats load instantly
```

Files:

| File | What it is |
|---|---|
| `index.html` | The page: lyrics area, control bar, search and settings screens |
| `style.css` | Dark, high-contrast car-screen styling with big buttons |
| `app.js` | Everything else: lyrics lookup, LRC parsing, sync clock, Spotify login, microphone and song ID |
| `worker.js` | **Optional** Cloudflare Worker proxy for AudD (only if step 5 below is needed) |

Your Spotify Client ID and AudD token are **not** in these files. You type them into the app's Settings, and they're saved only in that browser.

---

## Setup

### Step 1: Put it on GitHub Pages (about 5 minutes, easiest on a computer)

1. Go to <https://github.com/new>. Name the repository `tesla-karaoke`, keep it **Public**, and click **Create repository**.
2. On the new repo page, click **uploading an existing file**. Drag in `index.html`, `style.css` and `app.js` (add `README.md` and `worker.js` too if you like). Click **Commit changes**.
3. Go to **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main** and folder **/ (root)**. Click **Save**.
4. Wait about a minute. Your app is at:
   **<https://tarrynvennetodd.github.io/tesla-karaoke/>**

To update the app later, upload the changed file to the repo again. Pages refreshes within a minute or two.

### Step 2: Try Manual mode first

On your computer or phone:

1. Open the app and tap **Song**. Search for something (e.g. a song title and the artist).
2. Pick a result marked **Synced**.
3. Play the same song on your phone or speaker. When the first line is sung, **tap that line** on screen.
4. If the highlight runs early, tap **Lyrics ahead**. If it runs late, tap **Lyrics behind**.

### Step 3: Spotify hands-free (optional)

You need **Spotify Premium** on the account that creates the developer app.

1. Go to <https://developer.spotify.com/dashboard>, log in with your Spotify account and click **Create app**.
2. Fill it in:
   - **App name:** Car Karaoke (anything works)
   - **App description:** Personal lyrics display
   - **Redirect URI:** `https://tarrynvennetodd.github.io/tesla-karaoke/` then click **Add**. It must match exactly, including the trailing slash. The app also shows this address under Settings → Spotify.
   - Under the APIs question, tick **Web API**.
   - Agree to the terms and click **Save**.
3. Open the app's **Settings** in the dashboard and copy the **Client ID**. You do **not** need the Client Secret; never paste it anywhere.
4. In Car Karaoke: **Settings → Spotify Client ID**, paste it, tap **Connect Spotify**, log in and approve. You come back connected and the chip at the top turns green.
5. If Spotify answers "403" or says your user isn't registered: in the dashboard go to **User Management** and add your own Spotify name and email.

Tip for the car: bookmark this address with your Client ID on the end, so it comes back even if the car's browser forgets your settings:
`https://tarrynvennetodd.github.io/tesla-karaoke/#cid=PASTE_CLIENT_ID_HERE`

### Step 4: Listen / song ID (optional)

1. Sign up at <https://dashboard.audd.io/> and copy your **API token**. New accounts get 300 free requests.
2. In Car Karaoke: **Settings → AudD API token**, paste it. To just try it, the word `test` works as a token for a handful of IDs per day.
3. Tap **Listen** during a part of the song with vocals or a clear beat. Each Listen uses one request.

### Step 5: Only if Listen says it "could not reach the song-ID service"

That means the browser blocked a direct call to AudD. A free Cloudflare Worker fixes it and also keeps your token off the car:

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Go to **Workers & Pages → Create → Create Worker**, keep the default name and click **Deploy**.
3. Click **Edit code**, delete everything, paste in the contents of `worker.js` and click **Deploy**.
4. Go back to the worker → **Settings → Variables and Secrets → Add**:
   - `AUDD_TOKEN`, type **Secret**, value = your AudD token
   - `ALLOWED_ORIGIN`, type **Text**, value = `https://tarrynvennetodd.github.io`
5. Copy the worker's address (ends in `.workers.dev`) into Car Karaoke: **Settings → Proxy URL**. You can clear the token field in the app; the worker holds it now.

---

## Testing in the car

Do this parked.

1. **Check your software version.** Tap the car icon → Software. Microphone access needs **2026.26** or newer.
2. Open the browser, go to your app's address and **bookmark it** (use the `#cid=` version if you set up Spotify).
3. Open **Settings → What this browser supports**:
   - **Microphone API: Yes** means Listen can work.
   - **Settings saved between visits: No** means the car forgets your settings. Use the `#cid=` bookmark and expect to tap Connect Spotify again each drive.
4. **Mic test:** play music at your normal volume, then tap **Start test** in Settings and approve the mic prompt.
   - "Strong" or "okay": Listen should work.
   - The meter barely moves with music but jumps when you talk: the car is filtering its own audio out of the mic. Use Spotify or Manual instead.
5. **Spotify:** close Settings and play a song in the car's Spotify app. Within about 5 seconds the title appears and the lyrics lock on. If they're consistently early or late, tap **Lyrics ahead / behind** a few times. The app remembers that correction for future songs (reset it in Settings).
6. **Listen:** play anything (radio works) and tap **Listen**. About 10 seconds later the lyrics jump to the right line.
7. **Text size:** pick L, XL or XXL in Settings so you can read it at a glance from the driver's seat.

While driving: set it up before you leave. Spotify mode needs no touches at all. Keep glances short.

---

## Using it

| Control | What it does |
|---|---|
| **Tap any lyric line** | "This line is being sung right now." Manual: sets the time. Spotify: saves a timing correction |
| **Lyrics ahead** (⏪) | The highlight is ahead of the singer: move it back 0.5 s |
| **Lyrics behind** (⏩) | The highlight is behind the singer: move it forward 0.5 s |
| **Start / Pause** | Manual and Listen modes: run or stop the clock |
| **Sync** | Spotify mode: check Spotify right now |
| **Listen** | Identify the song with the mic. If it's the same song, it just re-syncs |
| **Song** | Search LRCLIB, or paste your own lyrics (LRC or plain) |
| **Chip at top right** | When Spotify is connected, tap to turn following on or off |

You can scroll the lyrics by hand to find a line; auto-scroll comes back after 5 seconds. On a computer: Space = start/pause, ← / → = nudge, `/` = search.

## Known limits

- **Plain lyrics** (no timestamps) are estimated. Tap 2–3 lines through the song and the rest fit around your taps.
- **Listen** is accurate to about ±1 second because AudD's timecode is in whole seconds. Nudge if needed.
- **Spotify** position arrives every few seconds; the app's clock fills the gaps. The saved correction handles the car's audio delay.
- **Coverage:** LRCLIB is strong for popular songs. Obscure tracks may have plain lyrics only or none.
- **Personal use:** lyrics are copyrighted by their writers, and LRCLIB is a community database rather than a licensed provider, so keep this as your own app rather than a public product.

## Next improvements

1. **Word-by-word highlighting** using LRCLIB's word-timed records (`hasWordSync`).
2. **Per-song timing memory**, so a song with slightly off lyrics remembers its own fix.
3. **Spotify controls** (skip, pause) from the app. Needs one more Spotify permission.
4. **Offline lyrics** for a favourite playlist, for spots with weak LTE.
5. **Report or fix bad timing** back to LRCLIB through its flag and publish endpoints.
6. **Register a free LRCLIB app ID** for higher rate limits if you ever share the app.
7. **Your own domain** instead of the github.io address.
