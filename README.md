# Medieval Arena

An original third-person arena duel that runs in the browser. You fight a Thornbeak, a thorn-backed flightless bird-beast, in a wooden stockade on a bright day. Around it is a medieval town of timber-framed houses, a bell tower, a city wall and a castle on a hill.

**Play:** https://str3aml1n3.github.io/medieval-arena/

Everything is generated at runtime with [three.js](https://threejs.org): the models are built from primitives, the textures are drawn on canvas, and the sounds are synthesized with the Web Audio API. The music is an original battle theme in D minor, written as MIDI note data and played with sampled General MIDI instruments: string ensemble, pizzicato, harp, nylon guitar (standing in for a lute), French horn, trumpet, recorder, timpani, taiko war drums and toms. The samples come from the FluidR3_GM SoundFont (CC-BY 3.0) via [midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts). The music gets more intense during fights. There are no external art or audio assets.

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

Click the game to capture the mouse for turning and camera pitch. The mouse wheel zooms.
