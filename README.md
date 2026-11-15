# Medieval Arena

An original third-person arena duel that runs in the browser. You fight a Thornbeak, a thorn-backed flightless bird-beast, in a stockade of logs and stone under a brooding, cloud-heavy sky. High overhead, a vast dome-shaped force barrier covers the town: mostly invisible, it shows as drifting patches of glowing, branching veins that stream and breathe like a living membrane, a glow along the horizon, and arcs of lightning that crackle across it and send ripples through it. Around it is a medieval town of timber-framed houses, a bell tower, a city wall and a castle on a hill.

**Play:** https://str3aml1n3.github.io/medieval-arena/

The Thornbeak is modelled in Blender by a Python script ([tools/build_thornbeak.py](tools/build_thornbeak.py)), which builds roughly 300 overlapping feathers, thorns, a hooked beak and talons around named joints and exports [models/thornbeak.glb](models/thornbeak.glb). To regenerate it, run `blender --background --factory-startup --python tools/build_thornbeak.py -- models/thornbeak.glb`. The game animates those joints procedurally.

The hero, an original sell-sword, is built the same way by [tools/build_hero.py](tools/build_hero.py), which exports [models/hero.glb](models/hero.glb) (about 53k triangles). He fights bare-headed: shaggy dark hair, a full beard, heavy brows and an old scar through one of them. His kit is European: a diamond-quilted gambeson that runs on as a quilted coat skirt to mid-thigh (slit front and back), a riveted brigandine of overlapping plates closed with buckled straps, a mail collar, rounded steel spaulders, elbow and knee cops, strapped vambraces and gauntlets, a plain belt with a sword belt slung low on the hips, a pouch, a rondel dagger, and strapped, cuffed boots. His sword has a wheel pommel and a diamond-section blade, and it sits in a matching scabbard. After building, the script bakes ambient occlusion into the vertex colours and weathers them with grime, road dust on the legs and rust in the crevices of the metal; in the game the metal is worn and dull but throws a small, crisp, cold highlight, and the stone and slate of the town catch a faint cold sheen. To regenerate it, run `blender --background --factory-startup --python tools/build_hero.py -- models/hero.glb`. The model uses the same joints as the old primitive hero, so all moves, sword draws and death falls animate unchanged, and the game falls back to the primitive hero if the file fails to load.

The town around the arena mixes four kinds of house: timber-framed houses, tall gable-fronted townhouses, plank-walled houses with lean-to sheds, and stone cottages. Their roofs are clay tile, slate, wooden shingle or thatch, built course by course from individual tiles that stand proud of the course below, with uneven, sagging lines. Plaster, stone, wood and iron are darkened and weathered with soot streaks, damp, moss and rust. Two stretches of the arena palisade and its gate have been rebuilt in stone. Neighbouring houses never share a type, roof covering or plaster. The stone is a matched set of colour, normal and roughness maps: the mortar is sunken and dead matte, every block has its own sheen, and wet streaks are slick. Slate and clay roofs get the same treatment from their tile textures, and the hero's steel carries a scratched, smudged roughness texture, so reflections break up across every surface. The arena floor is churned with mud and old stains, has puddles in its hollows, and is littered with straw and spent arrows, some stuck in the sand and the palisade.

Everything else is generated at runtime with [three.js](https://threejs.org): the other models are built from primitives, the textures are drawn on canvas, and the sounds are synthesized with the Web Audio API. The music is an original, slow and dark piece in D minor with Phrygian colour (62 BPM), written as MIDI note data and played with sampled General MIDI instruments: string ensemble, choir, pizzicato, harp, tubular bells, nylon guitar (standing in for a lute), French horn, trumpet, recorder, timpani, taiko war drums and toms. The samples come from the FluidR3_GM SoundFont (CC-BY 3.0) via [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts). The music gets more intense during fights. There are no external art or audio assets.

## Combat
- **Rhythm combos:** attack, then press again while the blade glints to chain up to four strikes (chop, then two cross-cuts, then a heavy overhead). If you press too early the chain breaks.
- **Directional swings:** hold A or D while attacking.
- **Parry:** right mouse. Stops pecks and staggers the beast. The charge drains a lot of stamina and can break your guard.
- **Step back:** Space. Gives brief invulnerability and can cancel your swing recovery.
- **Lock-on:** on by default while your sword is drawn (Tab toggles it).
- **Reading the beast:** its eyes flare before every strike. It circles, pecks (sometimes twice), crouches and screeches before a charging lunge, and leaps back to break long combos.
- **Rounds:** each round adds tougher and more numerous beasts.

## Controls
| Key | Action |
|---|---|
| W / S | forward / back |
| A / D | turn (strafe when locked on) |
| Q / E | strafe |
| Shift | run |
| F | draw / sheathe |
| LMB / J | attack |
| RMB / K | parry |
| Space | step back |
| Tab | lock-on |
| H | help |
| N | music on/off |
| M | mute all |
| Esc | pause menu (volume, mouse sensitivity, lock-on, restart) |

Click the game to capture the mouse for turning and camera pitch; pull the mouse up past level to drop the camera low and look up into the sky. The mouse wheel zooms.
