# Medieval Arena

An original third-person arena duel that runs in the browser. You fight a Thornbeak, a thorn-backed flightless bird-beast, in a stockade of logs and stone under a brooding, cloud-heavy sky. High overhead, a vast dome-shaped force barrier covers the town: mostly invisible, it shows as drifting patches of glowing, branching veins that stream and breathe like a living membrane, a glow along the horizon, and arcs of lightning that crackle across it and send ripples through it. Around it is a medieval town of timber-framed houses, a bell tower, a city wall and a castle on a hill.

**Play:** https://str3aml1n3.github.io/medieval-arena/

The Thornbeak is modelled in Blender by a Python script ([tools/build_thornbeak.py](tools/build_thornbeak.py)), which builds roughly 300 overlapping feathers, thorns, a hooked beak and talons around named joints and exports [models/thornbeak.glb](models/thornbeak.glb). To regenerate it, run `blender --background --factory-startup --python tools/build_thornbeak.py -- models/thornbeak.glb`. The game animates those joints procedurally.

The hero, an original sell-sword, is built the same way by [tools/build_hero.py](tools/build_hero.py), which exports [models/hero.glb](models/hero.glb) (about 53k triangles). He fights bare-headed, and his head is sculpted in code after the author's own: short dark back and sides, a mop of dark curls on top with lighter tips, thick dark brows, and a full dark beard greying on the cheeks. His kit is European: a diamond-quilted gambeson that runs on as a quilted coat skirt to mid-thigh (slit front and back), a riveted brigandine of overlapping plates closed with buckled straps, a mail collar, rounded steel spaulders, elbow and knee cops, strapped vambraces and gauntlets, a plain belt with a sword belt slung low on the hips, a pouch, a rondel dagger, and strapped, cuffed boots. His sword has a wheel pommel and a diamond-section blade, and it sits in a matching scabbard. After building, the script bakes ambient occlusion into the vertex colours and weathers them with grime, road dust on the legs and rust in the crevices of the metal; in the game the metal is worn and dull but throws a small, crisp, cold highlight, and the stone and slate of the town catch a faint cold sheen. To regenerate it, run `blender --background --factory-startup --python tools/build_hero.py -- models/hero.glb`. The model uses the same joints as the old primitive hero, so all moves, sword draws and death falls animate unchanged, and the game falls back to the primitive hero if the file fails to load.

The town around the arena mixes four kinds of house: timber-framed houses, tall gable-fronted townhouses, plank-walled houses with lean-to sheds, and stone cottages. Their roofs are clay tile, slate, wooden shingle or thatch, built course by course from individual tiles that stand proud of the course below, with uneven, sagging lines. Plaster, stone, wood and iron are darkened and weathered with soot streaks, damp, moss and rust. Two stretches of the arena palisade and its gate have been rebuilt in stone. Neighbouring houses never share a type, roof covering or plaster. The stone is a matched set of colour, normal and roughness maps: the mortar is sunken and dead matte, every block has its own sheen, and wet streaks are slick. Slate and clay roofs get the same treatment from their tile textures, and the hero's steel carries a scratched, smudged roughness texture, so reflections break up across every surface. The arena floor is grey, packed earth with patches of gravel, a ring trodden round the middle, a path in from the gate, and soggy green patches where grass still clings on. It is churned with mud and old stains, has puddles in its hollows, and is littered with straw and spent arrows, some stuck in the sand and the palisade.

The time of day follows your own clock: the sun rises at six and crosses the sky, the evening burns orange, and at night the arena is lit by the moon and the torches under a sky full of stars. The weather changes as you fight. Dry spells and showers take turns: clouds build into a grey lid, the sun is buried, the haze closes in and the light goes flat. Then rain slants across the stockade and splashes in the sand, the ground, stone and timber darken and turn slick, and the barrier strikes more often. Afterwards everything dries out slowly. The pause menu can also hold it dry or keep it raining.

Everything else is generated at runtime with [three.js](https://threejs.org): the other models are built from primitives, the textures are drawn on canvas, and the sounds are synthesized with the Web Audio API. The music is an original, slow and dark piece in D minor with Phrygian colour (62 BPM), written as MIDI note data and played with sampled General MIDI instruments: string ensemble, choir, pizzicato, harp, tubular bells, nylon guitar (standing in for a lute), French horn, trumpet, recorder, timpani, taiko war drums and toms. The samples come from the FluidR3_GM SoundFont (CC-BY 3.0) via [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts). There are three themes: day, night and a driving combat theme in the spirit of Gothic's battle music. At night crickets chirp around the arena. There are no external art or audio assets.

## Combat
- **Rhythm combos:** attack, then strike again once the cut has landed, when the blade glints, to chain up to six strikes: a chop, two cross-cuts, a weaving double cut (down to the left, the blade rolls over, down to the right — it can land twice), a turn-around strike (a full spin that cuts everything around you), then a heavy overhead. The window lasts through the recovery and a moment after it, so there's time to find the rhythm. Pressing before the cut lands (mashing) breaks the chain and shows TOO EARLY.
- **Directional swings:** hold A or D while attacking.
- **Parry:** right mouse. Stops pecks and staggers the beast. The charge drains a lot of stamina and can break your guard.
- **Jump / step back:** Space jumps; locked on, it steps back instead, with brief invulnerability, and can cancel your swing recovery.
- **Lock-on:** on desktop, hold the action key (LMB / E) to lock on, or press Tab to keep the lock on. On phones it's on by default. It stays on the same beast until that beast falls, and a gold chevron marks it. Flick the mouse left or right to switch to the next beast on that side.
- **From behind:** a cut into a beast's back bites deeper, always staggers it, and even stops a charge.
- **Knock-down:** a charge that hits you clean, without a parry, throws you flat on your back. Press Space (or attack, or W) to get up. You can't be hurt while you're down or getting up.
- **Reading the beast:** its eyes flare before every strike. It circles, pecks (sometimes twice), crouches and screeches before a charging lunge, and leaps back to break long combos. Later beasts learn to read your wind-up and spring aside, often pecking straight back in, so pick your moments.
- **Rounds:** each round adds tougher and more numerous beasts.

## Controls
The action key works as in medieval-sim: hold left mouse or E, then use W / A / D to swing and S to guard. While you hold it, the movement keys fight instead of walking.

| Key | Action |
|---|---|
| W / S | forward / back |
| A / D | turn (strafe when locked on) |
| Shift | run |
| Ctrl / F | draw / sheathe |
| LMB / E (hold) | action key: locks on to the beast in front while held |
| action + W / A / D | strike forward / left / right (press again to chain) |
| action + S | guard |
| click LMB / tap E, J | quick forward strike |
| RMB / K | parry |
| Space | jump; step back when locked on; get up when knocked down |
| Tab | lock-on |
| Mouse flick | switch the locked-on beast |
| R (hold) | look back |
| H | show / hide the controls tip (also in the pause menu) |
| N | music on/off |
| M | mute all |
| Esc | pause menu (volume, look sensitivity, brightness, weather, lock-on, restart) |

**On a phone held upright**, the controls are simplified for thumbs: a joystick in the lower-left corner moves you, and the rest of the screen is for fighting. Tap to strike (tap again as the blade glints to chain), touch and hold to guard, swipe left or right for a side cut, and swipe down to step back or get up. The sword draws itself, lock-on is always on, and ⇄ switches beast.

**Held sideways**, touch controls appear: a joystick under your left thumb and a look-pad for your right (drag to look, flick to switch beast), plus STRIKE, PARRY, STEP, DRAW, LOCK and pause buttons. The game goes full screen when you enter the arena. Resolution adapts to the frame rate on every device, so slower phones and laptops stay smooth.

Click the game to capture the mouse for turning and camera pitch; pull the mouse up past level to drop the camera low and look up into the sky. The mouse wheel zooms.

## Development
The loading, title and pause screens show the build number and date from [version.js](version.js), so you can tell which version is deployed. Bump it with every change: `python3 tools/bump_version.py`.

The icon (`favicon.ico`, `apple-touch-icon.png`, `icon-512.png`) is drawn by [tools/build_icon.py](tools/build_icon.py): `python3 tools/build_icon.py .` (needs Pillow).

See [docs/GAME.md](docs/GAME.md) for how the game is put together. Add `?auto=1` to the URL to skip the title screen. `window.__game` exposes the game state, and `__game.step(seconds)` runs the world without drawing, which makes quick checks easy from the console.

Several mechanics are adapted from the medieval-sim project: sticky, front-weighted lock-on, beasts reading your swings, knock-downs, the weather, the look-back key, strikes landing where you look, raw mouse input, and the debug hooks.
