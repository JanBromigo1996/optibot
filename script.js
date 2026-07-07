// Intersection Observer for scroll animations
// threshold 0.2 + a 1s CSS transition meant a section had to be 20% into
// view AND THEN take another full second to fade in — reported as text
// feeling like it starts "too late" relative to the camera, which reacts
// to scroll continuously with no such delay. Fires as soon as a sliver is
// visible now, paired with a shorter 0.55s transition in style.css.
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, { threshold: 0.01 });

document.querySelectorAll('.slide-up').forEach(el => observer.observe(el));

// Three.js Setup
let scene, camera, renderer, composer, bloomPass, robot, mixer;
let bodyBaseMat, bodyBlueMat, bodySidesMat, accentLight;
const clock = new THREE.Clock();

// Page-wide design elements (progress bar, ambient color wash, hero scroll
// hint) — driven from the same animate() loop as everything else rather
// than a second scroll listener, so they stay in lockstep with the camera.
const elScrollProgress = document.getElementById('scroll-progress');
const elAmbientGlow = document.getElementById('ambient-glow');
const elScrollHint = document.getElementById('scroll-hint');
let curGlowColor = new THREE.Color(0x0A84FF);
let lastGlowWriteAt = 0;

// Scroll state must live at module scope: animate() reads it every frame —
// declared inside init() it throws a ReferenceError that kills the whole
// render loop before composer.render(), leaving the background pure black.
let scrollFrac = 0; // damped, eased 0..1 position through the page

// ------------------------------------------------------------------
// Apple-style "scrollytelling": one persistent bot, no separate boxed
// renders per feature. Each section gets a camera + robot keyframe; we
// lerp smoothly between whichever two the current scroll position sits
// between. No section reads as "the image" — the bot IS the visual,
// sliding into the empty half of the row next to that section's text
// (see .visual-spacer in style.css, which reserves the space but draws
// nothing itself — no boxes, no borders, no visible frame anywhere).
// ------------------------------------------------------------------
const SECTION_IDS = ['section-hero', 'section-smart', 'section-style', 'section-multi', 'section-stats', 'section-light', 'download'];
// camLook.y is derived from robotY + a fraction of the camera distance,
// rather than hand-picked per keyframe — a fixed pixel offset only looks
// right at the one viewport height it was tuned against, and reports of the
// bot sitting "too low" / "covered by text" on other window sizes traced
// back to exactly that. Aiming the camera at a point *above* where the bot
// actually is pushes it consistently into the lower part of the frame as a
// proportion of the view, which holds regardless of viewport height (the
// same geometric relationship, just at a different pixel scale).
const VERTICAL_BIAS = 0.21;
// robot.position.y sits at the model's own *feet* (confirmed via a live
// Box3 check: box.min.y ≈ robot.position.y, box center is ~70 units
// higher) — the actual visually-dominant part is the head/eyes near the
// box center, not the origin point. Biasing off the raw origin was
// aiming the "clear the text" math at the feet, so the head (70 units
// higher than assumed) ended up ~0.15 of the frame higher than intended,
// squarely back in the text.
const HEAD_OFFSET = 70;
function withBias(camPosZ, robotY) { return robotY + HEAD_OFFSET + camPosZ * VERTICAL_BIAS; }

const RAW_KEYFRAMES = [
    // hero — centered under the headline. An earlier pass (z=1700) was
    // pulled back far enough to dodge the "Für Windows..." badge at
    // in-between viewport heights (~950px), but that same distance also
    // read as "static tiny bot in the middle of the screen" at every
    // height — reported feedback. Framing badge-clearance with vertical
    // offset (robotY) instead of pure distance keeps the bot roughly 2x
    // larger while still clearing the badge with real margin, verified at
    // 700/900/1080px viewport heights (mobile handled separately by
    // MOBILE_KEYFRAME).
    { camPos: [0, 0, 1200], robotX: 0, robotY: -185, rotY: 0 },
    // smart engine — text on the left, bot drifts into the right half.
    // Swing kept gentle (was ±92 / ±0.55, now ±65 / ±0.32) so the handoff
    // to the next section reads as a drift, not a disorienting cross-spin.
    { camPos: [0, 0, 420], robotX: 65, robotY: -95, rotY: 0.32 },
    // customization — text on the right, bot drifts into the left half
    { camPos: [0, 0, 420], robotX: -65, robotY: -95, rotY: -0.32 },
    // multi-bot lineup — pulled back so all five fit in frame; the main bot
    // is the middle of the lineup, four clones fan out either side of it
    { camPos: [0, 0, 1000], robotX: 0, robotY: -110, rotY: 0 },
    // stats display — text on the left, bot (showing the display, not eyes)
    // drifts into the right half, framed a bit closer so the display reads
    { camPos: [0, 0, 360], robotX: 60, robotY: -80, rotY: 0.22 },
    // lightweight — this section's text is centered (no side spacer to slot
    // into), so instead of competing for the same middle of the frame the
    // bot pulls back, rises, and shrinks toward the top — a small, distant
    // presence above the copy rather than sitting behind/through it
    { camPos: [0, 0, 640], robotX: 0, robotY: -20, rotY: 0.12, camLookYOverride: 95 },
    // download — pulled back further and low: this section stacks a link,
    // a button, AND a meta line above the bot. camPos.z=700 measured out to
    // the bot's head-top landing at screen-y≈580 (verified via direct NDC
    // projection against each text element's own getBoundingClientRect),
    // squarely on top of the meta text and the link below it. Pulling back
    // to 1100 (the "distance" lever — see withBias) drops head-top to
    // ≈620, clear of the meta line's bottom (~605) with real margin.
    { camPos: [0, 0, 1100], robotX: 0, robotY: -260, rotY: 0 },
];
const KEYFRAMES = RAW_KEYFRAMES.map(k => ({
    camPos: [k.camPos[0], k.camPos[1], k.camPos[2]],
    camLook: [0, k.camLookYOverride !== undefined ? k.camLookYOverride : withBias(k.camPos[2], k.robotY), 0],
    robotX: k.robotX,
    robotY: k.robotY,
    rotY: k.rotY
}));

// Curated looks the bot cycles through, live, while the "Dein Bot, dein
// Stil" section is in view — an animated demonstration of Studio
// customization instead of a static screenshot standing in for it. Runs
// through every accessory (Ears, Glasses, Hat, Antenna, both wheels), not
// just a couple, per the explicit ask to show "alle Accessoires...in
// verschiedenen Kombinationen". Headwear (hat/antenna) stays mutually
// exclusive and exactly one wheel is ever equipped, matching the real
// Studio's own equip-slot rules.
// Bumped from the previous muted set (desaturated navy/olive/slate) to
// fully saturated, near-neon accents — the bloom pass barely had anything
// to grab onto before, so the "color change" demo read as subtle instead
// of showing off. Every look below now has one properly punchy hue.
// "sides" (the visor bezel/trim) used to be left out of every look here —
// bodySidesMat was never touched by the cycle, so it sat permanently white
// regardless of which look was active, reading as an unfinished patch that
// clashed against the vivid body/accent colors (worst on the dark looks,
// where a big stuck-white bezel washed the whole face out pastel). Each
// look now gives it its own trim shade, cohesive with but distinct from
// the body color, matching how the real Studio treats "Körper (Seiten)"
// as its own colorable part.
const STYLE_LOOKS = [
    { body: 0xffffff, blue: 0x0057ff, sides: 0xf2f2f4, ears: false, glasses: false, hat: false, antenna: false, wheel1: false, material: 'Standard' },
    { body: 0xff2d1e, blue: 0x161616, sides: 0x1c1c1e, ears: true, glasses: false, hat: false, antenna: false, wheel1: false, material: 'Gloss' },
    { body: 0x0046ff, blue: 0xffffff, sides: 0xe3e3e8, ears: false, glasses: true, hat: false, antenna: false, wheel1: false, material: 'Chrome' },
    { body: 0xf5f5f7, blue: 0x00e5a8, sides: 0xd6d6da, ears: true, glasses: true, hat: false, antenna: false, wheel1: true, material: 'Satin' },
    { body: 0x1c1c1e, blue: 0xffb800, sides: 0x2c2c2e, ears: false, glasses: false, hat: true, antenna: false, wheel1: true, material: 'Matte' },
    { body: 0x9aa0a6, blue: 0x00d4ff, sides: 0x6e7378, ears: true, glasses: false, hat: false, antenna: true, wheel1: true, material: 'Chrome' },
    { body: 0xffffff, blue: 0xff2e8a, sides: 0xf2f2f4, ears: false, glasses: true, hat: false, antenna: true, wheel1: false, material: 'Gloss' },
];
let styleLookIndex = 0;
let styleLookTimer = 0;
const STYLE_LOOK_HOLD = 1.4; // seconds per look — was 2.2s, reported as too slow
const targetColor = { body: new THREE.Color(0xffffff), blue: new THREE.Color(0x2a4fd6), sides: new THREE.Color(0xf2f2f4) };
let targetMaterialName = 'Standard';

function applyAccessoryLook(look, target) {
    (target || robot).traverse(c => {
        if (c.name === 'Acessory_Ear_1_Left' || c.name === 'Acessory_Ear_1_Right') c.visible = look.ears;
        if (c.name === 'Acessory_VR_Glasses') c.visible = look.glasses;
        if (c.name === 'Acessory_Witchhat') c.visible = look.hat;
        if (c.name === 'Acessory_Antenna') c.visible = look.antenna;
        if (c.name === 'Acessory_Wheel_1' || c.name === 'Acessory_Wheel_1_Wheel') c.visible = look.wheel1;
        if (c.name === 'Acessory_Wheel_standard') c.visible = !look.wheel1;
    });
}

// A Disney/Pixar-style "pop" — a quick squash-then-overshoot on the whole
// body plus a small rotational kick — fired every time an accessory/look
// actually changes, so swapping outfits reads as a lively little reaction
// instead of a flat instant swap. Same damped-spring idiom used throughout
// the sister desktop-app project (vel += (k*(target-cur) - d*vel)*dt).
let baseRobotScale = 1;
let popScale = 1, popScaleVel = 0;
let popKick = 0, popKickVel = 0;
function triggerAccessoryPop() {
    popScaleVel -= 3.4;
    popKickVel += (Math.random() - 0.5) * 2.2;
}
function updateAccessoryPop(dt) {
    popScaleVel += (260 * (1 - popScale) - 15 * popScaleVel) * dt;
    popScale += popScaleVel * dt;
    popKickVel += (120 * (0 - popKick) - 9 * popKickVel) * dt;
    popKick += popKickVel * dt;
}

// ------------------------------------------------------------------
// Scroll-velocity tracking & derived physics
// ------------------------------------------------------------------
// prevScrollProgress: the progress value from the previous frame, used
// to derive a frame-to-frame velocity. Declared here so it survives
// across animate() calls without being a const inside the closure.
let prevScrollProgress = 0;
// scrollVelSmooth: exponentially-smoothed scroll velocity (progress
// units / second). Raw frame-to-frame deltas are extremely noisy
// (especially on trackpads); smoothing by ~8× per second gives a
// value that reacts quickly but isn't dominated by single-frame spikes.
let scrollVelSmooth = 0;

// ------------------------------------------------------------------
// Body inertia / head jiggle
// ------------------------------------------------------------------
// When the user scrolls, the target robot-Y position changes. Rather
// than the head just following instantly (it already eases via curRobotY),
// these springs add a *secondary* offset that lags behind and overshoots
// slightly — the head "resists" being dragged and then bounces back.
// This is the same "follow-through" principle animators use for hair,
// tails, or antenna — the body leads, attached parts trail.
let jiggleY = 0, jiggleVelY = 0;
let jiggleX = 0, jiggleVelX = 0;

// ------------------------------------------------------------------
// Eye expression physics
// ------------------------------------------------------------------
// eyeSX / eyeSY: spring-driven horizontal and vertical scale of the
// eye squircles on the face canvas. Rest position is 1×1 (normal).
// Fast scroll → surprised (wide+flat: scaleX up, scaleY down).
// Settling after scroll → eyes bounce tall momentarily (relief).
// Multi-bot section → eyes subtly wider and brighter (happy).
let eyeSX = 1, eyeSXVel = 0; // horizontal scale spring
let eyeSY = 1, eyeSYVel = 0; // vertical scale spring

// Find a clone/instance's own base/blue body materials by name — the
// original FBX-derived material names are lost once we replace them with
// fresh MeshPhysicalMaterial instances, so those replacements explicitly
// set .name (see the 'body_base'/'body_blue' tags below) specifically so
// clones stay independently identifiable and tintable after robot.clone().
function getBodyMats(obj) {
    let base = null, blue = null, sides = null, face = null;
    obj.traverse(c => {
        if (!c.isMesh || !c.material) return;
        if (c.material.name === 'body_base') base = c.material;
        if (c.material.name === 'body_blue') blue = c.material;
        if (c.material.name === 'body_sides') sides = c.material;
        if (c.material.name === 'wheelbot_face') face = c.material;
    });
    return { base, blue, sides, face };
}

// Material-finish presets (mirrors the real desktop app's MATERIAL_PRESETS)
// — cycling only body *color* was missing half of what Studio actually lets
// you change; this lets the demo show a genuine finish swap (Chrome/Matte/
// Gloss/...) alongside the color, lerped smoothly like everything else here.
const MATERIAL_PRESETS = {
    Standard: { roughness: 1.0, metalness: 1.0, clearcoat: 0.35, clearcoatRoughness: 0.25 },
    Chrome: { roughness: 0.05, metalness: 1.0, clearcoat: 0.6, clearcoatRoughness: 0.05 },
    Matte: { roughness: 1.0, metalness: 0.15, clearcoat: 0.0, clearcoatRoughness: 0.0 },
    Gloss: { roughness: 0.15, metalness: 0.1, clearcoat: 0.9, clearcoatRoughness: 0.03 },
    Satin: { roughness: 0.55, metalness: 0.25, clearcoat: 0.15, clearcoatRoughness: 0.4 },
};
const curMaterialProps = { roughness: 1.0, metalness: 1.0, clearcoat: 0.35, clearcoatRoughness: 0.25 };
function lerpMaterialTo(mats, presetName, t) {
    const p = MATERIAL_PRESETS[presetName] || MATERIAL_PRESETS.Standard;
    curMaterialProps.roughness += (p.roughness - curMaterialProps.roughness) * t;
    curMaterialProps.metalness += (p.metalness - curMaterialProps.metalness) * t;
    curMaterialProps.clearcoat += (p.clearcoat - curMaterialProps.clearcoat) * t;
    curMaterialProps.clearcoatRoughness += (p.clearcoatRoughness - curMaterialProps.clearcoatRoughness) * t;
    [mats.base, mats.blue, mats.sides].forEach(m => {
        if (!m) return;
        m.roughness = curMaterialProps.roughness;
        m.metalness = curMaterialProps.metalness;
        m.clearcoat = curMaterialProps.clearcoat;
        m.clearcoatRoughness = curMaterialProps.clearcoatRoughness;
    });
}
function setMaterialInstant(mats, presetName) {
    const p = MATERIAL_PRESETS[presetName] || MATERIAL_PRESETS.Standard;
    [mats.base, mats.blue, mats.sides].forEach(m => {
        if (!m) return;
        m.roughness = p.roughness;
        m.metalness = p.metalness;
        m.clearcoat = p.clearcoat;
        m.clearcoatRoughness = p.clearcoatRoughness;
    });
}

// ------------------------------------------------------------------
// Up to 5 bots at once: four extra clones (independent materials, own
// color) that fan out into a lineup only while the "Bis zu fünf auf
// einmal" section is in view. Each gets its own idle-motion phase offset
// so five bots don't breathe/bob in obvious lockstep.
// ------------------------------------------------------------------
// Each of the (up to 5) bots gets its own color, finish AND accessory —
// previously only color varied, so the "lineup" barely looked different
// bot to bot. Main bot (center, index 2 of 5 visually) keeps the plain
// default look; these four fill out the rest with real variety.
// Each bot keeps ONE fixed, saturated, clearly-distinct look for good —
// this used to swap between a primary/alt look on a timer, which read as
// the opposite of "5 individual bots" (their identity kept dissolving
// into each other instead of staying recognizable). Bot 4's body was
// near-white, same family as bot 1's — swapped to a dark teal so all four
// silhouettes are unambiguously different at a glance, not just the glow.
const EXTRA_BOT_LOOKS = [
    { body: 0xffffff, blue: 0x00e5ff, sides: 0xf2f2f4, ears: false, glasses: true, hat: false, antenna: false, wheel1: false, material: 'Chrome' }, // Auto — electric cyan, glasses, chrome
    { body: 0x331c08, blue: 0xffa000, sides: 0x40230a, ears: true, glasses: false, hat: false, antenna: false, wheel1: false, material: 'Matte' }, // Work — warm amber-brown body (a neutral near-black washed pale under the bright rim/bloom), vivid amber, ears, matte
    { body: 0x2a1030, blue: 0xff0080, sides: 0x241226, ears: false, glasses: false, hat: false, antenna: true, wheel1: true, material: 'Gloss' }, // Play — hot magenta, antenna, sport wheel, gloss
    { body: 0x0a1f2e, blue: 0x00ffb8, sides: 0x123241, ears: true, glasses: true, hat: false, antenna: false, wheel1: true, material: 'Satin' }, // deep teal + vivid mint, ears+glasses, sport wheel, satin
];
let extraBots = [];
// Per-bot bob/turn frequency+amplitude — every bot ran the exact same sine
// formula and only differed by phase, so five bots side by side still
// visibly breathed "in sync" once you looked for it. Distinct per-bot
// speeds/amplitudes make each one read as having its own small
// personality. Bumped up from the original values (reported as too slow).
const EXTRA_BOT_MOTION = [
    { bobFreq: 0.0026, bobAmp: 4.5, turnFreq: 0.0014, turnAmp: 0.17 },
    { bobFreq: 0.0038, bobAmp: 3.5, turnFreq: 0.0019, turnAmp: 0.25 },
    { bobFreq: 0.0021, bobAmp: 6.5, turnFreq: 0.0011, turnAmp: 0.13 },
    { bobFreq: 0.0031, bobAmp: 5, turnFreq: 0.0023, turnAmp: 0.2 },
];
function createExtraBots() {
    EXTRA_BOT_LOOKS.forEach((look, i) => {
        const clone = robot.clone(true);
        clone.traverse(c => {
            if (!c.isMesh || !c.material) return;
            // Some meshes carry a material *array*, not a single material —
            // .clone() only exists on the individual Material instances.
            if (Array.isArray(c.material)) c.material = c.material.map(m => m.clone());
            else c.material = c.material.clone();
        });
        const mats = getBodyMats(clone);
        if (mats.base) mats.base.color.setHex(look.body);
        if (mats.blue) mats.blue.color.setHex(look.blue);
        if (mats.sides) mats.sides.color.setHex(look.sides);
        // The face screen is by far the most eye-catching part of the head
        // at this framing, but it defaulted to the same fixed white-cyan
        // glow on every clone — tinting its emissive to the bot's own
        // accent color is what actually makes 5 bots read as distinct
        // instead of "one bot, five hats" (accessories were the only thing
        // differing before this).
        if (mats.face) mats.face.emissive.setHex(look.blue);
        setMaterialInstant(mats, look.material);
        applyAccessoryLook(look, clone);
        clone.userData.phase = i * 1.7 + 0.6; // desyncs the idle bob per bot
        clone.userData.scaleVal = 0;
        clone.userData.scaleVel = 0;
        clone.userData.mats = mats;
        clone.userData.popScale = 1;
        clone.userData.popScaleVel = 0;
        clone.visible = false;
        scene.add(clone);
        extraBots.push(clone);
    });
}

function updateExtraBots(dt, active, centerX, centerY) {
    // Fan positions either side of the main (center) bot — main bot takes
    // the middle slot, clones take the two on each side.
    const OFFSETS = [-260, -130, 130, 260];
    const now = Date.now();
    extraBots.forEach((bot, i) => {
        const target = active ? 1 : 0;
        // Bouncy pop-in on entrance (k=220/d=14, underdamped — the little
        // overshoot reads as lively), but a much stiffer, critically-damped
        // spring on exit (k=500/d=45) — the underdamped exit used to linger
        // as faint, slowly-shrinking ghosts for a second or more after
        // scrolling past the section, which is exactly what showed up as
        // "the animation is wrong" in a screenshot taken mid-scroll.
        const k = active ? 220 : 500, d = active ? 14 : 45;
        bot.userData.scaleVel += (k * (target - bot.userData.scaleVal) - d * bot.userData.scaleVel) * dt;
        bot.userData.scaleVal += bot.userData.scaleVel * dt;
        const s = Math.max(0, bot.userData.scaleVal);
        if (s < 0.01 && !active) { bot.visible = false; return; }
        bot.visible = true;

        // Previously each bot swapped between a primary and alt look on its
        // own clock — reported back as the opposite of what "5 individual
        // bots" should read as: instead of five bots with a stable, punchy,
        // recognizable identity, they kept quietly turning into each other.
        // Each bot now keeps its one assigned EXTRA_BOT_LOOKS look for good;
        // individuality now comes entirely from the per-bot bob/turn motion
        // below plus the (now more saturated) fixed colors themselves.
        const motion = EXTRA_BOT_MOTION[i];
        bot.userData.popScaleVel += (260 * (1 - bot.userData.popScale) - 15 * bot.userData.popScaleVel) * dt;
        bot.userData.popScale += bot.userData.popScaleVel * dt;

        bot.scale.setScalar(baseRobotScale * s * bot.userData.popScale);
        bot.position.x = centerX + OFFSETS[i] * Math.min(1, s);
        bot.position.y = centerY + Math.sin(now * motion.bobFreq + bot.userData.phase) * motion.bobAmp;
        bot.rotation.y = Math.sin(now * motion.turnFreq + bot.userData.phase) * motion.turnAmp;
    });
}

// ------------------------------------------------------------------
// Animated eyes: a lightweight version of the real app's live eye canvas
// (blink + a slow wandering gaze) instead of one static drawn-once frame,
// which read as "dead" with no motion at all in the face.
// ------------------------------------------------------------------
let faceCanvas, faceCtx, faceTex;
let nextBlinkAt = 0, blinkStart = -9999;
const BLINK_MS = 150;
let gazeX = 0, gazeY = 0, gazeTargetX = 0, gazeTargetY = 0, nextGazeAt = 0;

function initFaceTexture() {
    faceCanvas = document.createElement('canvas');
    faceCanvas.width = faceCanvas.height = 1024;
    faceCtx = faceCanvas.getContext('2d');
    faceTex = new THREE.CanvasTexture(faceCanvas);
    faceTex.encoding = THREE.sRGBEncoding;
    drawFace(0, 0, 0);
    return faceTex;
}

// scaleX / scaleY: spring-driven eye expression scale (see eyeSX/SY above).
// Kept as separate parameters rather than globals so drawFace stays a pure
// function and can be called from initFaceTexture without a scale value.
function drawFace(lidCoverage, offsetX, offsetY, scaleX = 1, scaleY = 1) {
    const ctx = faceCtx;
    ctx.fillStyle = '#04140a';
    ctx.fillRect(0, 0, 1024, 1024);

    // Base eye dimensions before expression scaling.
    // 210px is the "neutral" squircle size tuned to the face canvas resolution.
    const baseW = 210, baseH = 210;
    const eyeW = baseW * Math.max(0.3, scaleX);
    // scaleY and lidCoverage both reduce the height — multiply them so a
    // surprised (scaleY=0.75) mid-blink (lidCoverage=0.5) gives 0.75×0.5
    // of base height, not just one of them.
    const eyeH = Math.max(10, baseH * Math.max(0.05, scaleY) * (1 - lidCoverage));
    const eyeY = 512 - eyeH / 2;
    // Glow scales with openness — wider brighter eyes pop more
    const glow = 55 + scaleY * 30 + eyeW * 0.05;

    [364.5, 659.5].forEach(cx => {
        const ex = cx - eyeW / 2 + offsetX;
        const ey = eyeY + offsetY;
        const radius = Math.min(eyeW / 2, eyeH / 2, 72);

        // Outer glow
        ctx.save();
        ctx.shadowColor = 'rgba(25,242,255,0.9)';
        ctx.shadowBlur = glow;
        ctx.fillStyle = '#19f2ff';
        ctx.beginPath();
        ctx.roundRect(ex, ey, eyeW, eyeH, radius);
        ctx.fill();
        ctx.restore();

        // Specular highlight — a small bright streak in the top-right corner
        // of each eye that only appears when the eyes are open wide (scaleY>1),
        // giving them a moist/alive look (same trick 2D animators use for eyes).
        if (scaleY > 1.0 && eyeH > 60) {
            const hlW = eyeW * 0.22, hlH = eyeH * 0.28;
            ctx.save();
            ctx.globalAlpha = Math.min(0.85, (scaleY - 1.0) * 4.5);
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = 'rgba(255,255,255,0.6)';
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.roundRect(ex + eyeW * 0.58, ey + eyeH * 0.10, hlW, hlH, hlH / 2);
            ctx.fill();
            ctx.restore();
        }

        // Inner pupil — a slightly darker, smaller squircle centered inside the
        // eye. Reads as depth/iris at close framing (stats section close-up).
        if (eyeH > 40) {
            const pupilW = eyeW * 0.55, pupilH = eyeH * 0.55;
            ctx.save();
            ctx.globalAlpha = 0.25;
            ctx.fillStyle = '#05a8c0';
            ctx.beginPath();
            ctx.roundRect(cx - pupilW / 2 + offsetX, ey + (eyeH - pupilH) / 2, pupilW, pupilH, Math.min(pupilW, pupilH) * 0.45);
            ctx.fill();
            ctx.restore();
        }
    });
}

// Live-stats demo pages ("Immer im Blick") — the real app swipes between
// Face/CPU/RAM/GPU pages on the same physical display; this is a simplified
// version with the same big-bold-number layout, driven by simulated (not
// real, this is a marketing page, not the app) gently oscillating values.
const DISPLAY_PAGES = ['face', 'ram', 'cpu', 'gpu'];
let displayPageIndex = 0, displayPageTimer = 0, pageBlend = 0;
const DISPLAY_PAGE_HOLD = 1.8;

function drawStatPage(ctx, label, value, color) {
    ctx.fillStyle = '#04140a';
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.textAlign = 'center';
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 44;
    ctx.fillStyle = color;
    ctx.font = '800 250px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(Math.round(value) + '%', 512, 470);
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 46px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(label, 512, 555);

    const barW = 660, barH = 26, segs = 22, gap = 6;
    const bx = 512 - barW / 2, by = 615;
    const segW = (barW - gap * (segs - 1)) / segs;
    const filled = Math.round((value / 100) * segs);
    for (let i = 0; i < segs; i++) {
        ctx.fillStyle = i < filled ? color : 'rgba(255,255,255,0.1)';
        ctx.fillRect(bx + i * (segW + gap), by, segW, barH);
    }
}

// scaleX/Y: the current spring-driven eye expression scales (eyeSX/SY)
// passed in from animate() — updateFace is called at the end of the loop
// after those springs have already been ticked.
function updateFace(now, dt, statsActive, scaleX = 1, scaleY = 1) {
    if (statsActive) {
        displayPageTimer += dt;
        if (displayPageTimer > DISPLAY_PAGE_HOLD) {
            displayPageTimer = 0;
            displayPageIndex = (displayPageIndex + 1) % DISPLAY_PAGES.length;
        }
    } else if (displayPageIndex !== 0 || displayPageTimer !== 0) {
        displayPageIndex = 0;
        displayPageTimer = 0;
    }

    if (now > nextBlinkAt) {
        blinkStart = now;
        // Blink faster when excited (high eyeSY), slower when calm
        nextBlinkAt = now + (1800 + Math.random() * 2800) / Math.max(0.6, scaleY);
    }
    const t = now - blinkStart;
    let lidCoverage = 0;
    if (t >= 0 && t < BLINK_MS) {
        const half = BLINK_MS / 2;
        lidCoverage = t < half ? (t / half) : (1 - (t - half) / half);
    }

    if (now > nextGazeAt) {
        gazeTargetX = (Math.random() - 0.5) * 0.75;
        gazeTargetY = (Math.random() - 0.5) * 0.4;
        // Eyes dart quickly to new position (0.14 factor per frame at 60fps),
        // then ease in slowly — mimics the saccade + smooth-pursuit split of
        // real eye movement rather than a single constant lerp speed.
        nextGazeAt = now + 1200 + Math.random() * 2200;
    }
    // Dart phase: snap most of the way there in the first 80ms after a new
    // target is set (high lerp factor), then ease the remaining distance slowly.
    const gazeAge = now - (nextGazeAt - (1200 + 2200 / 2)); // approximate
    const gazeFactor = gazeAge < 80 ? 0.22 : 0.04;
    gazeX += (gazeTargetX - gazeX) * gazeFactor;
    gazeY += (gazeTargetY - gazeY) * gazeFactor;

    const mode = DISPLAY_PAGES[displayPageIndex];
    if (mode === 'face') {
        drawFace(lidCoverage, gazeX * 38, gazeY * 26, scaleX, scaleY);
    } else {
        const wobble = Math.sin(now * 0.0006 + (mode === 'ram' ? 0 : mode === 'cpu' ? 2.1 : 4.2));
        const value = Math.max(8, Math.min(96, 52 + wobble * 34));
        const color = mode === 'ram' ? '#19f2ff' : mode === 'cpu' ? '#ffb84d' : '#ff5ec4';
        const label = mode === 'ram' ? 'ARBEITSSPEICHER' : mode === 'cpu' ? 'PROZESSOR' : 'GRAFIKKARTE';
        drawStatPage(faceCtx, label, value, color);
    }
    faceTex.needsUpdate = true;
}

function init() {
    const container = document.getElementById('webgl-container');

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.set(0, 60, 430);

    // failIfMajorPerformanceCaveat: false — see isWebGLAvailable() above.
    // Without it, environments limited to software rendering (no real GPU
    // passthrough) get refused a context entirely instead of a slower-but-
    // working one, which is what silently forced the static-fallback path.
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance", failIfMajorPerformanceCaveat: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1); // Solid black for website background
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);

    // Environment Lighting
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    scene.environment = pmremGenerator.fromScene(new THREE.RoomEnvironment(), 0.04).texture;

    // Previously way too bright/flat (1.5 key + 0.4 ambient + 1.15 exposure)
    // — the body blew out to near-white and read as "dead", with nothing
    // for the eye-glow to contrast against. Toned down across the board so
    // the body has real shading and the eyes are the brightest thing in frame.
    // Further reduced again here + a dedicated rim light added below: flat
    // front lighting on a matte-ish white body washes out toward the same
    // near-white as everything else, so the silhouette barely separates
    // from the pure-black backdrop — classic "product on black" photography
    // fixes this with an edge/rim light, not just less front light.
    // Cinematic pass: a "product photo on black" look needs real contrast
    // between a tight, slightly warm key and a near-absent ambient — flat
    // even lighting is what reads as "cheap render" no matter how bright.
    // Key intensity goes up but ambient goes DOWN at the same time, so the
    // lit face of the bot gets punchier highlights while the shadow side
    // stays genuinely dark instead of just uniformly dimmer.
    // Pulled back again from a previous pass (key 1.1/ambient 0.11/exposure
    // 1.02/bloom 0.5@threshold 0.76): that combination was reported back as
    // "all colors are pale and washed out" — a lower bloom threshold makes
    // MORE of the frame bloom, and bloom desaturates whatever it touches
    // toward white, which fights directly against "punchier colors".
    // Brightness was never really the problem; saturation/contrast was.
    const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.0);
    dirLight.position.set(100, 200, 50);
    scene.add(dirLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.08);
    scene.add(ambientLight);

    // Rim/kicker light from behind-and-above: puts a bright edge along the
    // top/back of the head so the bot's outline reads clearly against black
    // even where the front key light doesn't reach.
    const rimLight = new THREE.DirectionalLight(0x8fd6ff, 1.7);
    rimLight.position.set(-120, 160, -180);
    scene.add(rimLight);

    // Low front fill aimed at the wheel: dark rubber tire on a near-black
    // backdrop otherwise reads as "missing" (a real bug found in an earlier
    // pass on the Studio scene — same fix needed here).
    const wheelFill = new THREE.PointLight(0xbfd8ff, 1.2, 320, 2);
    wheelFill.position.set(40, -30, 160);
    scene.add(wheelFill);

    // Dynamic accent light: color-matched to whatever the live customization
    // accent color currently is (see targetColor.blue in animate()), so the
    // "punchier colors" and "cinematic lighting" asks reinforce each other —
    // the bloom pass picks up this light's color as a soft colored glow that
    // shifts with every outfit change instead of lighting staying neutral
    // while only the material color changes.
    accentLight = new THREE.PointLight(0x2a4fd6, 1.6, 420, 2);
    accentLight.position.set(-60, 40, 200);
    scene.add(accentLight);

    renderer.toneMappingExposure = 0.96;

    // Composer
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    // Tighter and higher-threshold than before: strength 0.5@threshold 0.76
    // bloomed too much of the frame, washing saturated body colors toward
    // white instead of reading as punchy. Only the genuinely brightest
    // points (eye glow, specular highlights) should bloom now.
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.36, 0.4, 0.84);
    composer.addPass(bloomPass);

    // Real PBR maps, same set the app itself uses (FBX-embedded texture refs
    // have always been broken in this project — materials must be built by hand).
    const texLoader = new THREE.TextureLoader();
    const baseColorMap = texLoader.load('Textures/WheelBot_Body_BaseColor.png');
    baseColorMap.encoding = THREE.sRGBEncoding;
    const normalMap = texLoader.load('Textures/WheelBot_Body_Normal.png');
    const metalnessMap = texLoader.load('Textures/WheelBot_Body_Metallic.png');

    initFaceTexture();

    // Load Model
    const loader = new THREE.FBXLoader();
    loader.load('wheelbot.fbx', function (object) {
        robot = object;

        robot.traverse(function (child) {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((m, i) => {
                const name = (m.name || '').toLowerCase();
                let nm;
                if (child.name === 'Acessory_Wheel_1') {
                    // The tire ring itself has no usable material name in the
                    // FBX (empty string) and was inheriting a stray white
                    // default as a result — its hub child mesh ("..._Wheel")
                    // correctly reuses body_sides, but this outer tire needs
                    // its own explicit black-rubber material, matched by
                    // mesh name instead since the material name is blank here.
                    nm = new THREE.MeshPhysicalMaterial({
                        color: 0x0e0e10, roughness: 0.92, metalness: 0.05
                    });
                } else if (name === 'wheelbot_face') {
                    nm = new THREE.MeshPhysicalMaterial({
                        map: faceTex, emissiveMap: faceTex,
                        emissive: 0xffffff, emissiveIntensity: 1.4,
                        color: 0xffffff, roughness: 0.15, metalness: 0.6,
                        clearcoat: 0.7, clearcoatRoughness: 0.08
                    });
                    nm.name = 'wheelbot_face'; // kept identifiable post-clone(); see getBodyMats
                } else if (name.includes('body_blue')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        color: 0x2a4fd6, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35,
                        clearcoat: 0.35, clearcoatRoughness: 0.25
                    });
                    nm.name = 'body_blue'; // kept identifiable post-clone(); see getBodyMats
                    bodyBlueMat = nm;
                } else if (name.includes('body_sides')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        map: baseColorMap, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35,
                        clearcoat: 0.35, clearcoatRoughness: 0.25
                    });
                    nm.name = 'body_sides';
                    bodySidesMat = nm;
                } else if (name.includes('body_base')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        color: 0xffffff, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35,
                        clearcoat: 0.35, clearcoatRoughness: 0.25
                    });
                    nm.name = 'body_base'; // kept identifiable post-clone(); see getBodyMats
                    bodyBaseMat = nm;
                } else {
                    nm = new THREE.MeshPhysicalMaterial({
                        color: m.color || 0x888888, roughness: 0.4, metalness: 0.5
                    });
                }
                if (Array.isArray(child.material)) child.material[i] = nm;
                else child.material = nm;
            });
        });

        // Accessories are named "Acessory_*" (capital A, the modeler's own
        // spelling). Wheel_standard always stays on (part of the default
        // silhouette); Ears/Glasses are toggled live by the style-look cycle.
        robot.traverse(child => {
            if (child.name.startsWith('Acessory_')) {
                child.visible = (child.name === 'Acessory_Wheel_standard');
            }
        });

        // Center and Scale
        const box = new THREE.Box3().setFromObject(robot);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 140 / maxDim;

        robot.scale.set(scale, scale, scale);
        robot.position.set(-center.x * scale, KEYFRAMES[0].robotY, -center.z * scale);
        baseRobotScale = scale;

        if (robot.animations && robot.animations.length > 0) {
            mixer = new THREE.AnimationMixer(robot);
            mixer.clipAction(robot.animations[0]).play();
        }

        scene.add(robot);
        createExtraBots();
    });

    window.addEventListener('resize', onWindowResize);

    // A small, damped mouse parallax ON TOP of the scripted rotation — not
    // a replacement for it. The previous version set rotation.y directly
    // from the raw mouse position on every single mousemove event with no
    // smoothing at all, which is exactly what read as jittery/distracting
    // behind body text. This just nudges a target the render loop eases
    // toward, capped small enough to be a subtle "aliveness" cue only.
    window.addEventListener('mousemove', (e) => {
        mouseTargetX = ((e.clientX / window.innerWidth) * 2 - 1) * 0.12;
        mouseTargetY = (-(e.clientY / window.innerHeight) * 2 + 1) * 0.05;
    });
}

let mouseTargetX = 0, mouseTargetY = 0;
let mouseX = 0, mouseY = 0;

// Current (eased) camera/robot state — lerped toward the active keyframe
// blend every frame rather than snapped, for the smooth Apple-style feel.
const curCam = { pos: new THREE.Vector3(0, 60, 430), look: new THREE.Vector3(0, 40, 0) };
let curRobotX = 0, curRobotY = KEYFRAMES[0].robotY, curRotY = 0;

function getSectionProgress() {
    // Which keyframe pair we're between, and how far — driven by each
    // section's own position in the document rather than a raw scroll-pixel
    // ratio, so it stays correct regardless of section heights.
    //
    // Real bug fixed here: this used to measure the *viewport's own center*
    // against section boundaries. Since each section is roughly one
    // viewport-height tall, that means the moment a section merely scrolls
    // into view at all, the viewport's center is already sitting near that
    // section's own midpoint — so at scrollY=0 (page freshly loaded, hero
    // fully in view, no scrolling done at all) this reported progress≈0.5,
    // i.e. already half-blended toward the *next* keyframe before the user
    // touched anything. That's exactly why the bot could render on top of
    // the hero text at rest: it was never actually showing hero's own
    // keyframe, always some blend toward "smart". Using the viewport's own
    // *top* edge instead means progress is exactly N at the moment section N
    // first fills the viewport from the top, and reaches N+1 only once
    // you've scrolled a full section further — the mapping actually intended.
    const sections = SECTION_IDS.map(id => document.getElementById(id)).filter(Boolean);
    if (sections.length === 0) return 0;
    const scrollTop = window.scrollY;
    let idx = 0;
    for (let i = 0; i < sections.length; i++) {
        const rect = sections[i].getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if (scrollTop >= top) idx = i;
    }
    const cur = sections[idx];
    const next = sections[idx + 1];
    if (!next) return idx;
    const curTop = cur.getBoundingClientRect().top + window.scrollY;
    const nextTop = next.getBoundingClientRect().top + window.scrollY;
    const span = Math.max(1, nextTop - curTop);
    const frac = Math.max(0, Math.min(1, (scrollTop - curTop) / span));
    return idx + frac;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.resolution.set(window.innerWidth, window.innerHeight);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Below ~900px, .visual-spacer is hidden and every section's text stacks
// full-width (see the matching CSS breakpoint) — the desktop keyframes'
// left/right robotX offsets were tuned for a side-by-side layout and just
// collide with stacked text on a narrow screen. Below that width, every
// section instead reuses the "lightweight" treatment (small, high, out of
// the way) that already reads cleanly against centered text.
// Pulled back and pushed down from an earlier version that had the bot's
// head overlapping the "Für Windows 10 & 11 · Kostenlos" badge on real
// phone-sized viewports — confirmed via direct NDC head-top projection
// against the badge's own screen rect (badge bottom ~579px vs head-top
// ~603px at the old values, i.e. actually already touching once real text
// line heights are accounted for). Re-tuned so head-top lands ~635px,
// a real ~56px clear gap under the badge at a 390x844 viewport.
const MOBILE_KEYFRAME = { camPos: [0, 240, 1500], camLook: [0, 260, 0], robotX: 0, robotY: -190, rotY: 0.1 };
// Short desktop windows (e.g. a 1440x700 browser) hit the same text-overlap
// problem as phones — the hero copy's vertical position is set by CSS
// padding, not by viewport height, so a shorter window just brings the
// same fixed-world-position bot closer to the text underneath it. Reusing
// the phone treatment (smaller, further down) below a height threshold
// fixes both cases with one keyframe instead of tuning two.
function isMobileView() { return window.innerWidth < 900 || window.innerHeight < 760; }

function animate() {
    requestAnimationFrame(animate);
    // Two different deltas on purpose. rawDelta is the actual elapsed time —
    // needed so the camera/robot ease can immediately catch all the way up
    // after a stall (throttled background tab, remote-desktop/low-power
    // rendering, a long GC pause) instead of crawling back at a fixed small
    // step regardless of how long the stall was. The clamped `delta` still
    // feeds the spring-physics (accessory pop, extra-bot bob) and the
    // animation mixer, which — unlike the unconditionally-stable exponential
    // ease — use explicit Euler integration and really can blow up or
    // overshoot wildly if fed a multi-second dt in one step.
    const rawDelta = clock.getDelta();
    const delta = Math.min(rawDelta, 0.05);
    if (mixer) mixer.update(delta);

    mouseX += (mouseTargetX - mouseX) * 0.04;
    mouseY += (mouseTargetY - mouseY) * 0.04;

    const progress = getSectionProgress();

    // ---- Scroll velocity (progress units / second) -------------------------
    // Frame-to-frame progress delta divided by real elapsed time. Clamped so
    // a single huge stall frame (tab switch, GC pause) doesn't spike the
    // physics into wild territory.
    const rawVel = rawDelta > 0 ? Math.min(8, Math.abs((progress - prevScrollProgress) / rawDelta)) : 0;
    const velSign = (progress - prevScrollProgress) >= 0 ? 1 : -1;
    prevScrollProgress = progress;
    // Smooth by ~8× per second (fast enough to feel responsive, slow enough
    // to suppress trackpad micro-jitter)
    scrollVelSmooth += (rawVel - scrollVelSmooth) * Math.min(1, rawDelta * 8);

    // ---- Body jiggle / head inertia ----------------------------------------
    // The jiggle target is proportional to scroll velocity: scrolling DOWN
    // (velSign +1) pulls the head DOWN (jiggleY < 0, i.e. negative offset)
    // so it "trails" behind the camera's upward pan — exactly the follow-
    // through you'd feel if the head were attached to the body by a spring.
    const jiggleTargetY = velSign * scrollVelSmooth * -22;
    // Underdamped spring so there's a small overshoot on settle (the head
    // bobs back up when you stop scrolling). k=70, d=9 → ζ≈0.54.
    jiggleVelY += (70 * (jiggleTargetY - jiggleY) - 9 * jiggleVelY) * delta;
    jiggleY += jiggleVelY * delta;
    // Horizontal jiggle: mouse-parallax direction change causes a small tilt
    jiggleVelX += (60 * (-jiggleX) - 9 * jiggleVelX) * delta;
    jiggleX += jiggleVelX * delta;

    // ---- Eye expression springs --------------------------------------------
    // Target eye scale is a function of scroll speed and current section.
    // Three states: calm (rest), alert (medium speed), surprised (fast scroll)
    // Each uses a different (scaleX, scaleY) pair:
    //   calm      → 1.00 × 1.00  perfect squircle
    //   alert     → 1.04 × 1.14  taller/more attentive
    //   surprised → 1.20 × 0.72  wide + vertically squashed
    // When in the multi section the bot looks "happy": slightly wider + brighter
    let targetSX, targetSY;
    if (scrollVelSmooth > 2.2) {
        targetSX = 1.22; targetSY = 0.68; // fast → surprised
    } else if (scrollVelSmooth > 0.55) {
        targetSX = 1.04; targetSY = 1.16; // medium → alert / attentive
    } else {
        // Determine section-based expression from progress (multiActive not
        // yet computed at this point, so check the range directly)
        const inMulti = progress >= 3 && progress < 3.82;
        targetSX = inMulti ? 1.10 : 1.00;
        targetSY = inMulti ? 1.08 : 1.00; // multi → happy/wide
    }
    // Underdamped spring: k=180/d=13 → ζ≈0.48, gives a nice snappy bounce
    // when transitioning from surprised back to calm (eyes spring open then
    // settle to normal, like a rubber band releasing).
    eyeSXVel += (180 * (targetSX - eyeSX) - 13 * eyeSXVel) * delta;
    eyeSX += eyeSXVel * delta;
    eyeSYVel += (180 * (targetSY - eyeSY) - 13 * eyeSYVel) * delta;
    eyeSY += eyeSYVel * delta;
    const mobile = isMobileView();
    const i0 = Math.max(0, Math.min(KEYFRAMES.length - 1, Math.floor(progress)));
    const i1 = Math.min(KEYFRAMES.length - 1, i0 + 1);
    const t = progress - i0;
    const k0 = mobile ? MOBILE_KEYFRAME : KEYFRAMES[i0];
    const k1 = mobile ? MOBILE_KEYFRAME : KEYFRAMES[i1];

    const targetCamPos = [
        lerp(k0.camPos[0], k1.camPos[0], t),
        lerp(k0.camPos[1], k1.camPos[1], t),
        lerp(k0.camPos[2], k1.camPos[2], t)
    ];
    const targetCamLook = [
        lerp(k0.camLook[0], k1.camLook[0], t),
        lerp(k0.camLook[1], k1.camLook[1], t),
        lerp(k0.camLook[2], k1.camLook[2], t)
    ];
    const targetRobotX = lerp(k0.robotX, k1.robotX, t);
    const targetRobotY = lerp(k0.robotY, k1.robotY, t);
    const targetRotY = lerp(k0.rotY, k1.rotY, t);

    // Ease everything toward its target. This used to converge with a ~0.145s
    // time constant (fine for a *static* target), but the target here moves
    // continuously while scrolling — at any real scroll speed the steady-
    // state lag (≈ targetSpeed × timeConstant) was large enough that the bot
    // visibly never caught up before the user had already scrolled past a
    // section, reported as "too slow, you miss it." Tightened to a ~0.045s
    // time constant: still smooths out raw per-frame scroll jitter, but
    // tracks fast scrolling closely enough to actually arrive.
    const ease = 1 - Math.pow(0.000000001, rawDelta); // frame-rate-independent damping, uncapped so a stalled tab catches up in one step on resume
    curCam.pos.x = lerp(curCam.pos.x, targetCamPos[0], ease);
    curCam.pos.y = lerp(curCam.pos.y, targetCamPos[1], ease);
    curCam.pos.z = lerp(curCam.pos.z, targetCamPos[2], ease);
    curCam.look.x = lerp(curCam.look.x, targetCamLook[0], ease);
    curCam.look.y = lerp(curCam.look.y, targetCamLook[1], ease);
    curCam.look.z = lerp(curCam.look.z, targetCamLook[2], ease);
    curRobotX = lerp(curRobotX, targetRobotX, ease);
    curRobotY = lerp(curRobotY, targetRobotY, ease);
    curRotY = lerp(curRotY, targetRotY, ease);

    camera.position.set(curCam.pos.x + mouseX * 20, curCam.pos.y, curCam.pos.z);
    camera.lookAt(curCam.look.x, curCam.look.y, curCam.look.z);

    // On mobile there's no side-space for the bot to sit in (text stacks
    // full-width), and a fixed-position canvas can't "dodge" scrolling text
    // the way a per-section camera cut can on desktop. Rather than have it
    // permanently collide with whichever paragraph happens to scroll past,
    // fade it out once you leave the hero (where there's real open space
    // above/below the copy) and back in near the download CTA (same deal).
    if (mobile) {
        // Only the hero has real open space around the text on a stacked
        // mobile layout; everywhere else, fade down to a faint background
        // presence rather than colliding with whichever paragraph is
        // currently scrolled into that fixed screen position.
        // progress semantics changed with the getSectionProgress fix above:
        // 0 = hero fully in view, 1 = fully transitioned to the next section
        // — fade out over that whole range instead of the old (now wrong)
        // halfway point.
        const showHero = Math.max(0, 1 - progress / 0.9);
        const targetOpacity = Math.max(showHero, 0.05);
        const curOpacity = parseFloat(renderer.domElement.style.opacity || '1');
        renderer.domElement.style.opacity = String(lerp(curOpacity, targetOpacity, 0.06));
    } else if (renderer.domElement.style.opacity !== '1') {
        renderer.domElement.style.opacity = '1';
    }

    // Each section's own span is progress ∈ [N, N+1) — active windows use a
    // small ±0.15 bleed on each edge for a smooth cross-fade into/out of the
    // neighboring section, NOT a wide window (an earlier version widened
    // these to fix a different bug — the style cycle turning off before the
    // section's own end — but overshot so far that neighboring sections'
    // windows overlapped by more than half, which is why the stats display
    // was showing up while still inside the multi-bot section below).
    // No cross-section bleed at all, on either edge: measured directly, the
    // natural "resting" position for section N (its content nicely centered
    // in the viewport) lands at progress≈N+0.05 — close to, but not exactly,
    // the section's own start. Any bleed past the section's own [N, N+1)
    // span, however small, risks still being "active" while at rest one
    // section later (confirmed: a 0.08 bleed still had the multi-bot lineup
    // fully visible while resting in "stats", one section past "multi").
    // multiActive ends at 3.82 rather than 4.0 — the extra bots need a ~0.18
    // progress-unit head start to fully spring-exit (k=500/d=45 spring has a
    // ~0.18 s time constant) before the camera snaps to the close-up stats
    // framing (z=360). Without the lead, all four bots are still at full scale
    // and visible at the frame edges when the "Immer im Blick" section arrives.
    const styleActive = progress >= 2 && progress < 3;
    const multiActive = progress >= 3 && progress < 3.82;
    const statsActive = progress >= 4 && progress < 5;

    if (robot) {
        // Layered on top of the scripted per-section rotY — a slow side-to-
        // side "looking around" turn plus a smaller, faster secondary sine
        // for a bit of restless energy, and a gentle nod. Previously the
        // only motion between scroll-driven camera cuts was the breathing
        // bob, so the bot read as static/emotionless while holding a
        // section — reported feedback ("mehr Emotion und Umschauen").
        const lookAround = Math.sin(Date.now() * 0.00042) * 0.16 + Math.sin(Date.now() * 0.0011 + 2.1) * 0.06;
        const nod = Math.sin(Date.now() * 0.00065 + 1.7) * 0.05;
        robot.position.x = curRobotX + jiggleX;
        // Idle breathing bob PLUS jiggle offset — the head trails scroll
        // and then overshoots back, layered on top of the constant breathe.
        robot.position.y = curRobotY + Math.sin(Date.now() * 0.0018) * 4 + jiggleY;
        robot.rotation.y = curRotY + mouseX * 0.15 + lookAround;
        // Tilt forward slightly when scrolling down (head tips forward as if
        // leaning into the scroll), backward on scroll up — feels physical.
        robot.rotation.x = mouseY * 0.06 + nod + jiggleY * 0.0025;

        updateAccessoryPop(delta);
        robot.scale.setScalar(baseRobotScale * popScale);
        robot.rotation.z = popKick;

        // Live color/accessory cycle while the "Dein Bot, dein Stil" section
        // is in view — a little squash-and-kick "pop" (see triggerAccessoryPop)
        // fires on every actual change so swapping outfits reads as a lively
        // reaction (Pixar-style anticipation/overshoot) instead of an instant cut.
        const bodyMats = { base: bodyBaseMat, blue: bodyBlueMat, sides: bodySidesMat };
        if (styleActive && bodyBaseMat && bodyBlueMat) {
            styleLookTimer += delta;
            if (styleLookTimer > STYLE_LOOK_HOLD) {
                styleLookTimer = 0;
                styleLookIndex = (styleLookIndex + 1) % STYLE_LOOKS.length;
                const look = STYLE_LOOKS[styleLookIndex];
                targetColor.body.setHex(look.body);
                targetColor.blue.setHex(look.blue);
                targetColor.sides.setHex(look.sides);
                targetMaterialName = look.material;
                applyAccessoryLook(look);
                triggerAccessoryPop();
            }
            bodyBaseMat.color.lerp(targetColor.body, 0.07);
            bodyBlueMat.color.lerp(targetColor.blue, 0.07);
            if (bodySidesMat) bodySidesMat.color.lerp(targetColor.sides, 0.07);
            lerpMaterialTo(bodyMats, targetMaterialName, 0.08);
        } else if (bodyBaseMat && bodyBlueMat) {
            // Outside the customization section, ease back to the default
            // look (and reset the cycle) so later sections ("Federleicht",
            // Download) show the bot's standard look rather than whatever
            // look the cycle happened to land on.
            styleLookIndex = 0;
            styleLookTimer = 0;
            const def = STYLE_LOOKS[0];
            targetColor.body.setHex(def.body);
            targetColor.blue.setHex(def.blue);
            targetColor.sides.setHex(def.sides);
            targetMaterialName = def.material;
            bodyBaseMat.color.lerp(targetColor.body, 0.03);
            bodyBlueMat.color.lerp(targetColor.blue, 0.03);
            if (bodySidesMat) bodySidesMat.color.lerp(targetColor.sides, 0.03);
            lerpMaterialTo(bodyMats, targetMaterialName, 0.03);
            applyAccessoryLook(def);
        }

        updateExtraBots(delta, multiActive, curRobotX, robot.position.y);
    }

    if (accentLight) accentLight.color.lerp(targetColor.blue, 0.04);

    // Ambient page glow tracks the same accent color as the 3D scene's own
    // accentLight, so the atmosphere behind the text shifts with it too —
    // subtle (low alpha) on purpose, this is a mood wash, not a spotlight.
    // The color itself eases every frame (cheap, plain math), but the
    // actual DOM write is throttled to ~12fps: writing this custom property
    // repaints a full-viewport gradient, and a slow color wash gains
    // nothing visually from doing that at the WebGL canvas's full 60fps.
    if (elAmbientGlow) {
        curGlowColor.lerp(targetColor.blue, 0.03);
        const now = performance.now();
        if (now - lastGlowWriteAt > 80) {
            lastGlowWriteAt = now;
            const r = Math.round(curGlowColor.r * 255), g = Math.round(curGlowColor.g * 255), b = Math.round(curGlowColor.b * 255);
            elAmbientGlow.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.16)`);
        }
    }

    if (elScrollProgress) {
        const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
        const pct = Math.max(0, Math.min(1, window.scrollY / maxScroll)) * 100;
        elScrollProgress.style.width = pct + '%';
    }
    if (elScrollHint) {
        elScrollHint.style.opacity = progress < 0.12 ? '1' : '0';
    }

    updateFace(performance.now(), delta, statsActive, eyeSX, eyeSY);
    composer.render();
}

// WebGL can genuinely fail to initialize — not just on old hardware, but in
// any environment that can't hand out real GPU acceleration: virtualized
// displays, some remote-desktop/screen-sharing sessions, sandboxed contexts.
// Previously, if THREE.WebGLRenderer's constructor threw there, it happened
// *inside* init(), which aborted before animate() was ever called — meaning
// not just the bot but the scroll-progress bar, the ambient glow, and every
// other per-frame effect silently never started. The page still loaded and
// scrolled, so nothing looked "broken" in an obvious way, just permanently
// static — exactly what "the animations don't work" describes from the
// outside, and exactly the kind of failure automated testing on a machine
// with working GPU acceleration will never reproduce. Detect this up front
// and degrade to a real, intentional-looking fallback instead of a silent
// no-op.
function isWebGLAvailable() {
    try {
        const c = document.createElement('canvas');
        // failIfMajorPerformanceCaveat defaults to false in the spec, but
        // some browsers/configs still refuse a *hardware* context outright
        // when only software rendering (e.g. SwiftShader) is available and
        // silently hand back null — which this check, without the flag
        // made explicit, was reading as "no WebGL at all" and permanently
        // falling back to the static logo. Explicitly allowing the
        // performance caveat lets it succeed as a software context instead
        // — slower, but the real animated scene, not a static placeholder.
        // This was very likely the actual cause behind repeated "the bot is
        // tiny, static, and centered" reports: exactly what the fallback's
        // small logo watermark looks like, on a machine where real WebGL
        // would have worked fine if we'd just allowed it to be slow.
        const opts = { failIfMajorPerformanceCaveat: false };
        return !!(window.WebGLRenderingContext && (c.getContext('webgl', opts) || c.getContext('experimental-webgl', opts)));
    } catch (e) {
        return false;
    }
}

function startFallbackMode() {
    document.body.classList.add('no-webgl');
    // The bot itself can't render without WebGL, but everything else that
    // doesn't depend on it — nav, section reveal-on-scroll, the download
    // button, the scroll-progress bar — should still work rather than the
    // whole page reading as dead. This is a tiny independent loop, not the
    // full animate(), so it has nothing to fail on.
    function fallbackTick() {
        requestAnimationFrame(fallbackTick);
        if (elScrollProgress) {
            const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight);
            const pct = Math.max(0, Math.min(1, window.scrollY / maxScroll)) * 100;
            elScrollProgress.style.width = pct + '%';
        }
    }
    fallbackTick();
}

if (isWebGLAvailable()) {
    try {
        init();
        animate();
    } catch (e) {
        console.error('WebGL init failed despite feature detection, falling back:', e);
        startFallbackMode();
    }
} else {
    startFallbackMode();
}
