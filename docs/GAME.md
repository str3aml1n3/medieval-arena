# Game architecture

Everything runs from one ES module, `game.js`, on three.js 0.160 (loaded from unpkg through the import map in
`index.html`). There is no build step. The only files the game loads are `models/hero.glb` and `models/thornbeak.glb`,
plus the music samples streamed from midi-js-soundfonts. Everything else (geometry, textures, sounds) is generated at
runtime. If a model fails to load, the game falls back to its primitive version.

## Startup (`preload`)
1. Build the town, then load both GLB models.
2. Spawn a throw-away beast and put the sword in the hero's hand, so every material is in the scene.
3. Compile all shaders up front (`renderer.compileAsync`). Physical materials are slow to compile on Windows/ANGLE, and
   this avoids a freeze the first time a beast appears.
4. Start the audio graph. The music samples keep streaming in the background.

## Frame (`loop` → `tick` → `drawFrame`)
`tick(rdt)` advances the world by one step. `dt` is the game time: hit-stop slows it to 6 % and slow motion (the
killing blow) to 35 %. The camera, HUD and damage numbers run on real time (`rdt`).

`drawFrame` renders in two passes. A depth-only pre-pass draws every opaque mesh with a colourless material, and then
the real pass shades each pixel exactly once. Transparent things, particles, lines, the sky and the barrier only go
through the second pass, on layer 1.

## The world is fixed
While the world is built, `Math.random` is a seeded generator (mulberry32, `TOWN_SEED`). This covers the ground shape, the clutter, the town (each house's type, roof, plaster and size) and the mountains, so every visit shows the same town. Real randomness comes back for play once the town stands. `?seed=N` tries another layout. Within each ring a house type returns no sooner than 3 houses on.

## Wall bases (`groundBlend`)
Where the palisade, stone and plank walls meet the ground, the shader blends in the earth instead of leaving a seam. Ragged, noisy mud creeps up the bottom of each wall and goes matte, and the normals bend toward the ground's, so the base takes the light like the floor does. A matching trodden-mud band runs along the inside of the wall. It's real time, so it works with the moving sun.

## Terrain
`groundH(x, z)` is the single height function. Its small bumps are value noise (`fbm2`), as is `macro()`, the large-scale colour variation, because sine sums showed up as regular waves and stripes. The terrain mesh, feet, blood decals, pebbles, puddles and the rain
splashes all use it.

## Hero
The hero is a joint hierarchy, either `buildHero()` (primitives) or `buildHeroGLB()` (Blender model with the same joint
names). Animation is procedural:

- **Poses** (`POSE`) are sets of joint Euler angles. `blend` mixes two poses, and `applyHero` damps the joints toward
  the target pose at a rate `k`.
- **Strikes** (`SWINGS`, `COMBO`) are a wind-up pose followed by a sequence of strike poses. `cuts` marks which
  segments can wound. The weaving cut lands twice, and the turn-around strike spins the whole body (`visYaw`).
- **Locomotion** is layered over the upper-body pose: hip swing, knee fold, pelvis twist, arm swing, lean into
  acceleration and bank into turns. There is also breathing, an idle weight shift, and writhing after a hit.

### Player states (`P.state`)
| State | What happens |
|---|---|
| `idle` / `block` | Move, turn, parry (right mouse). Stamina regenerates. |
| `draw` | Draw or sheathe the sword. |
| `attack` | Wind-up `w`, strike `a`, recovery `r`. Pressing attack after the strike chains the next strike. Pressing during the wind-up or strike breaks the chain (no mashing). |
| `dodge` | Step back (Space), with 0.28 s of invulnerability. |
| `hurt` | Stunned. A hit from behind uses the pitched-forward `hurtB` pose. |
| `down` | Knocked flat by a charge that landed clean. Space, attack or W gets him up after 0.7 s, and he rises on his own after 2.4 s. Untouchable while down. |
| `getup` | 0.5 s rising crouch, still untouchable. |
| `dead` | Thrashes, then lies still. |

## Input
- **Keyboard and mouse:** the action key works as in medieval-sim. `actionHeld()` is true while left mouse or E is down. It locks on, and with the sword out it turns W / A / D into strikes (`AtkF` / `AtkL` / `AtkR` in `pressed`) and S into a guard; holding a direction when the action key goes down strikes at once. A quick click on its own (under 250 ms, no direction) is a forward strike. Ctrl or F draws the sword. `beforeunload` asks before the tab closes mid-fight, because Ctrl+W can't be blocked.
- **Touch** (`touch`): shown on coarse-pointer devices and as soon as the screen is touched. A floating joystick on the left 45 % of the screen feeds `touch.stick`, which is analog: the speed follows how far the stick is pushed, and pushing it to the rim runs. The rest of the screen is a look-pad that calls the same `look()` as the mouse. The buttons feed `pressed` the same way the keyboard does. On short screens the menus tighten, and in portrait a rotate hint covers the game.
- **Portrait phones:** `touch.portrait` is on when a touch device is taller than it is wide. The joystick zone is the lower-left quarter, and the rest of the screen is gestures. A tap strikes. A touch held 180 ms guards (`touch.parry`); tap or hold is judged from the events' own timestamps. A swipe of 38 px or more sideways is a side cut, and a swipe down is a step back. Lock-on is forced on, and `fitFov()` widens the vertical field of view so the horizontal one stays around 64° or more.
- **Chaining:** the window opens 50 ms after the cut (`winStart = w + a + 0.05`), when the blade glints. A press up to 70 ms before that is queued (`P.queued`) and fires as the window opens; anything earlier sets `P.failed` (TOO EARLY). The window lasts to the end of the recovery, and `chainGrace` adds 0.3 s after it. PERFECT means the strike landed in the first 35 % of the window.
- **Dynamic resolution** (`adaptResolution`): the frame rate is measured over 2 s windows. Below 40 fps the pixel ratio steps down to as low as 0.6, and above 57 fps it steps back up to the cap (2, or 1.5 on touch devices, which also start with a 1024 shadow map and no MSAA).

## Look
- **Bars:** Gothic-style bars (`barSkins`). The worn iron frame with tapered, riveted ends is a canvas used as a CSS `border-image`. The grainy, bevelled fills are canvases too, and they are cut by `clip-path` rather than squeezed.
- **Worn UI:** `uiSkins()` draws a grain texture, a quieter backdrop grain and two wear masks (chips, pits, scratches) and hands them to CSS as variables. Big lettering is a rubbed gold gradient clipped to the text and eroded by the wear mask; buttons, touch buttons and panels get the grain and a lighter wear.
- **Wet ground:** `wetGround()` patches the ground materials. A world-space noise mask decides which hollows go dark and glossy first as the rain soaks in (`groundWet`), and `rebakeEnv()` re-captures the sky reflection whenever the cloud cover changes by 0.2, so wet ground reflects a grey sky, not a blue one.
- **Build stamp:** `version.js` (build number and UTC date) is shown on the loading, title and pause screens. `tools/bump_version.py` bumps it.
- **Hero head** (`buildFace`): sculpted in code after the player's photos, replacing the model's own head, hair and beard, which stay hidden. The skin is a dense sphere shaped by feature functions: a rounder face, a straight nose, modest brows, full cheeks, lips, a chin and the neck, with fair, rosier tones on the cheeks, nose and lips. The hair, beard and brows are shells grown from that surface where their masks say hair grows. The back and sides are short. The hairline recedes at the temples, with a forelock in the middle. The full dark beard has fine grey on the cheeks and runs down the neck. On top sit about 230 spiral curl tubes, dark at the root with lighter tips. The ears and brown eyes with lids are added as separate meshes.
- **Hero detail:** the leather, the boots and the hair get procedural detail textures (`triplanarDetail`): pebbled grain with creases and scuffs, or strands gathered in tufts. The model has no UVs, so they're projected from three sides. The bump comes from the texture's own slope, so it stays smooth at any resolution. Ball-joint fillers on the torso hide the gap between the shoulder and the arm.
- **Mountains:** one ring of terrain pushed up by ridged noise, with vertex colours for the forested foothills, the rock and the snow.
- **Reflections:** materials avoid the plastic look. There's no clearcoat on the armour, leather or boots; the stone and roof sheen is neutral and weaker; and the sky reflection on dull surfaces is turned down. A patch to `lights_fragment_end` adds approximate specular occlusion: the sky reflection on non-metals fades with the direct light reaching the point, down to a third in full shadow.
- **Grass:** each tuft is a clump of 11 curved, tapering blades with vertex colours, swaying in the wind in the vertex shader (`grassWind`). The tufts skip the depth pre-pass, which would draw them without the sway. Short tufts also grow in the arena's green patches.
- **Arena floor:** `arenaPatches(x, z)` gives the gravel, green and track weights that tint the floor and place those tufts.

## Lock-on
On desktop, lock-on is off by default: holding the action key locks on, and Tab keeps it on. On touch devices it's on by default, and always on in portrait. The locked beast glows a soft, breathing gold, and the beast you would lock next glows fainter (`Beast.hl`). The lock is **sticky**: `lockTarget` stays on one
beast until that beast dies or is more than 15 m away. It doesn't jump to whichever beast is nearest this frame. A new
lock goes to the beast with the lowest `distance × (2.2 − facing)` score, which means the nearest beast roughly in
front (the scoring comes from medieval-sim's `acquireLock`). While locked, the mouse doesn't turn the hero; a quick
horizontal flick (`flickX` > 140 px, decaying fast) calls `switchTarget(side)`, which picks the next beast in that
direction. A gold chevron (`#lockmark`) floats over the locked beast.

## Beasts (`class Beast`)
The Thornbeak is a state machine: `wait` → `enter` → `circle` ⇄ `approach` → `peckWind` → `peck` → `peckRec`, plus
`lungeWind` → `lunge` → `lungeRec`, `backoff`, `stagger`, `hop`, `taunt` and `dead`. Its eyes flare during every
wind-up. Each round raises HP, damage (`dmgMul`), aggression (`aggr`) and the number of beasts.

- **Reading the hero** (after medieval-sim's `fight()`): each swing aimed at a beast that is circling or approaching
  gets one roll against `skill`, made during the wind-up (`reacted` holds the swing id). On a success the beast springs
  aside and back with brief invulnerability, and often pecks straight back as it lands. `skill` starts at 4 % and rises
  7 points per round, up to 45 %.
- **Combo breaker:** after three quick hits it may leap back out of the chain.
- **Hyper-armour:** a charging beast doesn't flinch from normal blows.
- **From behind:** a cut landing in the beast's back half does 1.35× damage, always staggers it, and gets past both the
  hyper-armour and the combo breaker.

## Day and night (`Daylight`)
The sun follows the player's clock. It rises at 6:00, peaks at about 54° at noon, and sets at 18:00, with a golden hour around sunrise and sunset. `SUN_DIR` drives the sky shader (sun disc, orange horizon, cloud undersides, darkening, stars, the moon opposite the sun) and the single directional light. That light is the sun by day and a dim blue moon by night. The fog, the sky and ground light, the exposure and the torches all follow. `Daylight.update()` runs every 2 s. `?hour=21.5` (or `__game.setHour`) fixes the time.

**Shadows** are real sun or moon shadows from the shadow map. The map is re-rendered every other frame. Nothing is baked.

## Weather (`Weather`)
After medieval-sim's weather. In **Changing** mode (the default), dry spells (100–220 s) and showers (60–130 s) take
turns. `cloud` moves toward 0 or 1 over about 28 s. `rain` follows it once the cloud cover passes half, and `wet`
soaks in quickly and dries over about a minute. Together they drive:

- the sky shader's `overcast` uniform (grey sky, buried sun, a closed cloud lid),
- the fog colour and density, and the sun, fill and sky light,
- the roughness and darkening of the sand, grass, stone and wood,
- 1500 rain streaks looping through a box that follows the camera, slanted by the wind,
- splash particles in the sand around the hero,
- two filtered noise beds for the sound of the rain,
- how often the barrier strikes.

**Dry** and **Rain** in the pause menu force one or the other.

## Light shafts (`Shafts`)
The occlusion pass draws only the characters and large meshes (layer 2), at 1/5 resolution. It switches off entirely once the sky is more than about half overcast.
These are screen-space volumetric light. A quarter-resolution pass draws the sun as a bright disc with every opaque mesh in black in front of it, and is redrawn every other frame. A radial blur from the sun's screen position is then added over the frame. The pass is skipped when the sun is behind the camera, has set, or is hidden by cloud; the pause menu can also turn it off.

## Barrier
`Weather.agitation` (clouds and rain) controls how agitated the dome is. Under a clear sky it is faint and patchy, it moves slowly, and strikes are rare. In a storm it surfaces widely, seethes faster on its own clock, and strikes come every second or two, often in bursts.
The barrier is a dome shader: a veined, breathing membrane that only shows in drifting patches. Lightning arcs are
random walks along the sphere, and each one also rings the dome and lights the clouds. As in medieval-sim, 75 % of the
strikes land where the camera is looking, and the crackle is panned toward the strike.

## Audio
There are **three music themes**. *Day* is the calm D-minor piece. *Night* is emptier and darker: a hushed drone, the choir breathing in and out, falling harp notes and a rare recorder. *Combat* is in the Gothic battle style: driving staccato strings, war drums on and off the beat, horn calls and timpani rolls. Themes change on a bar line and their layers cross-fade; combat cuts in at the next bar. At night, **crickets** chirp around the arena (`Ambience`). They go quiet in rain and while the game is paused.

All sound effects are synthesized (`nz` filtered noise, `tn` tones, `voice` formant synthesis for the hero's cries).
`nz` can pan. The score is MIDI note data played on sampled General MIDI instruments, and its intensity follows the
fight. A hidden tab suspends the AudioContext.

## Settings (pause menu, saved in `localStorage` as `arena-settings`)
Music and sound volume, mouse sensitivity, brightness (tone-mapping exposure), weather, and lock-on.

## Debug hooks
| Hook | Effect |
|---|---|
| `?auto=1` | Skip the title screen and start fighting at once. |
| `window.__game` | `{ P, beasts, hero, camera, scene, THREE, game, settings, Weather, POSE, startRound, resetGame, startAttack, hitPlayer, currentTarget, switchTarget, acquireLock, barrierSpawn, lockTarget, lockOn, press(code), hold(code, on), step(seconds) }` |
| `__game.step(s)` | Run the world for `s` seconds in 1/60 s steps without drawing. Inputs from `press` (one tick) and `hold` apply. |
| `window.__freezeAI = true` | Stop the beasts. |
| `window.__noRender = true` | Skip drawing (keeps software-rendered tests responsive). |
| `window.__dbgCam = { pos, target }` | Fix the camera. |
| `__game.bench(n)` | Average frame cost (simulation + drawing) over n frames, with draw calls and triangles. |

For example, to check the knock-down from the console:

```js
const G = __game, e = G.beasts[0];
e.setState('lunge'); G.hitPlayer(e, 20, true);   // P.state → 'down'
G.step(1); G.press('Space'); G.step(0.6);        // → 'getup' → 'idle'
```
