# Palisade Arena

An original third-person arena duel that runs in the browser. You fight a Thornbeak, a thorn-backed flightless bird-beast, inside a torch-lit wooden stockade at dusk.

**Play:** https://str3aml1n3.github.io/palisade-arena/

Everything is generated at runtime with [three.js](https://threejs.org): the models are built from primitives, the textures are drawn on canvas, and the sounds are synthesized with the Web Audio API. There are no external art or audio assets.

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
| H / M | help / mute |

Click the game to capture the mouse for turning and camera pitch. The mouse wheel zooms.
