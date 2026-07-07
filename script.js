// Intersection Observer for scroll animations
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, { threshold: 0.2 });

document.querySelectorAll('.slide-up').forEach(el => observer.observe(el));

// Three.js Setup
let scene, camera, renderer, composer, bloomPass, robot, mixer;
let bodyBaseMat, bodyBlueMat;
const clock = new THREE.Clock();

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
const SECTION_IDS = ['section-hero', 'section-smart', 'section-style', 'section-light', 'download'];
const KEYFRAMES = [
    // hero — centered, raised so he reads as present/alive right under the
    // headline rather than sunk near the bottom of the viewport
    { camPos: [0, 65, 520], camLook: [0, 42, 0], robotX: 0, robotY: -168, rotY: 0 },
    // smart engine — text on the left, bot drifts into the right half
    { camPos: [10, 55, 380], camLook: [0, 48, 0], robotX: 92, robotY: -90, rotY: 0.55 },
    // customization — text on the right, bot drifts into the left half
    { camPos: [-10, 55, 380], camLook: [0, 48, 0], robotX: -92, robotY: -90, rotY: -0.55 },
    // lightweight — this section's text is centered (no side spacer to slot
    // into), so instead of competing for the same middle of the frame the
    // bot pulls back, rises, and shrinks toward the top — a small, distant
    // presence above the copy rather than sitting behind/through it
    { camPos: [0, 150, 640], camLook: [0, 95, 0], robotX: 0, robotY: -20, rotY: 0.12 },
    // download — pulled back and lower: this section is shorter (630px) and
    // has its own "Zur Anleitung" link near the bottom, which the bot was
    // sitting directly on top of at a higher position
    { camPos: [0, 40, 560], camLook: [0, 25, 0], robotX: 0, robotY: -195, rotY: 0 },
];

// Curated looks the bot cycles through, live, while the "Dein Bot, dein
// Stil" section is in view — an animated demonstration of Studio
// customization instead of a static screenshot standing in for it. Runs
// through every accessory (Ears, Glasses, Hat, Antenna, both wheels), not
// just a couple, per the explicit ask to show "alle Accessoires...in
// verschiedenen Kombinationen". Headwear (hat/antenna) stays mutually
// exclusive and exactly one wheel is ever equipped, matching the real
// Studio's own equip-slot rules.
const STYLE_LOOKS = [
    { body: 0xffffff, blue: 0x2a4fd6, ears: false, glasses: false, hat: false, antenna: false, wheel1: false },
    { body: 0xe8452c, blue: 0x1c1c1e, ears: true, glasses: false, hat: false, antenna: false, wheel1: false },
    { body: 0x2a4fd6, blue: 0xffffff, ears: false, glasses: true, hat: false, antenna: false, wheel1: false },
    { body: 0xf5f5f7, blue: 0x7ddfc3, ears: true, glasses: true, hat: false, antenna: false, wheel1: true },
    { body: 0x1c1c1e, blue: 0xae8f2a, ears: false, glasses: false, hat: true, antenna: false, wheel1: true },
    { body: 0x9aa0a6, blue: 0x2c2c2e, ears: true, glasses: false, hat: false, antenna: true, wheel1: true },
    { body: 0xffffff, blue: 0x7ddfc3, ears: false, glasses: true, hat: false, antenna: true, wheel1: false },
];
let styleLookIndex = 0;
let styleLookTimer = 0;
const STYLE_LOOK_HOLD = 2.2; // seconds per look
const targetColor = { body: new THREE.Color(0xffffff), blue: new THREE.Color(0x2a4fd6) };

function applyAccessoryLook(look) {
    robot.traverse(c => {
        if (c.name === 'Acessory_Ear_1_Left' || c.name === 'Acessory_Ear_1_Right') c.visible = look.ears;
        if (c.name === 'Acessory_VR_Glasses') c.visible = look.glasses;
        if (c.name === 'Acessory_Witchhat') c.visible = look.hat;
        if (c.name === 'Acessory_Antenna') c.visible = look.antenna;
        if (c.name === 'Acessory_Wheel_1' || c.name === 'Acessory_Wheel_1_Wheel') c.visible = look.wheel1;
        if (c.name === 'Acessory_Wheel_standard') c.visible = !look.wheel1;
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

function drawFace(lidCoverage, offsetX, offsetY) {
    const ctx = faceCtx;
    ctx.fillStyle = '#04140a';
    ctx.fillRect(0, 0, 1024, 1024);
    const eyeH = Math.max(14, 210 * (1 - lidCoverage));
    const eyeY = 512 - eyeH / 2;
    [364.5, 659.5].forEach(cx => {
        ctx.save();
        ctx.shadowColor = 'rgba(25,242,255,0.9)';
        ctx.shadowBlur = 60;
        ctx.fillStyle = '#19f2ff';
        ctx.beginPath();
        ctx.roundRect(cx - 105 + offsetX, eyeY + offsetY, 210, eyeH, Math.min(70, eyeH / 2));
        ctx.fill();
        ctx.restore();
    });
}

function updateFace(now) {
    if (now > nextBlinkAt) {
        blinkStart = now;
        nextBlinkAt = now + 2400 + Math.random() * 3200;
    }
    const t = now - blinkStart;
    let lidCoverage = 0;
    if (t >= 0 && t < BLINK_MS) {
        const half = BLINK_MS / 2;
        lidCoverage = t < half ? (t / half) : (1 - (t - half) / half);
    }

    if (now > nextGazeAt) {
        gazeTargetX = (Math.random() - 0.5) * 0.7;
        gazeTargetY = (Math.random() - 0.5) * 0.35;
        nextGazeAt = now + 1800 + Math.random() * 2600;
    }
    gazeX += (gazeTargetX - gazeX) * 0.05;
    gazeY += (gazeTargetY - gazeY) * 0.05;

    drawFace(lidCoverage, gazeX * 34, gazeY * 22);
    faceTex.needsUpdate = true;
}

function init() {
    const container = document.getElementById('webgl-container');

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.set(0, 60, 430);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
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
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(100, 200, 50);
    scene.add(dirLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.22);
    scene.add(ambientLight);

    // Low front fill aimed at the wheel: dark rubber tire on a near-black
    // backdrop otherwise reads as "missing" (a real bug found in an earlier
    // pass on the Studio scene — same fix needed here).
    const wheelFill = new THREE.PointLight(0xbfd8ff, 1.4, 320, 2);
    wheelFill.position.set(40, -30, 160);
    scene.add(wheelFill);

    renderer.toneMappingExposure = 0.95;

    // Composer
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.4, 0.82);
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
                if (name === 'wheelbot_face') {
                    nm = new THREE.MeshPhysicalMaterial({
                        map: faceTex, emissiveMap: faceTex,
                        emissive: 0xffffff, emissiveIntensity: 1.4,
                        color: 0xffffff, roughness: 0.15, metalness: 0.6,
                        clearcoat: 0.7, clearcoatRoughness: 0.08
                    });
                } else if (name.includes('body_blue')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        color: 0x2a4fd6, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35,
                        clearcoat: 0.35, clearcoatRoughness: 0.25
                    });
                    bodyBlueMat = nm;
                } else if (name.includes('body_sides')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        map: baseColorMap, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35
                    });
                } else if (name.includes('body_base')) {
                    nm = new THREE.MeshPhysicalMaterial({
                        color: 0xffffff, normalMap: normalMap, metalnessMap: metalnessMap,
                        roughness: 1.0, metalness: 1.0, envMapIntensity: 1.35,
                        clearcoat: 0.35, clearcoatRoughness: 0.25
                    });
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

        if (robot.animations && robot.animations.length > 0) {
            mixer = new THREE.AnimationMixer(robot);
            mixer.clipAction(robot.animations[0]).play();
        }

        scene.add(robot);
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
    const sections = SECTION_IDS.map(id => document.getElementById(id)).filter(Boolean);
    if (sections.length === 0) return 0;
    const viewCenter = window.scrollY + window.innerHeight * 0.5;
    let idx = 0;
    for (let i = 0; i < sections.length; i++) {
        const rect = sections[i].getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if (viewCenter >= top) idx = i;
    }
    const cur = sections[idx];
    const next = sections[idx + 1];
    if (!next) return idx;
    const curTop = cur.getBoundingClientRect().top + window.scrollY;
    const nextTop = next.getBoundingClientRect().top + window.scrollY;
    const span = Math.max(1, nextTop - curTop);
    const frac = Math.max(0, Math.min(1, (viewCenter - curTop) / span));
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
const MOBILE_KEYFRAME = { camPos: [0, 240, 980], camLook: [0, 200, 0], robotX: 0, robotY: -30, rotY: 0.1 };
function isMobileView() { return window.innerWidth < 900; }

function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    if (mixer) mixer.update(delta);

    mouseX += (mouseTargetX - mouseX) * 0.04;
    mouseY += (mouseTargetY - mouseY) * 0.04;

    const progress = getSectionProgress();
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

    // Ease everything toward its target — the actual "cinematic scroll"
    // feel comes from this damping, not from the raw scroll value itself.
    const ease = 1 - Math.pow(0.001, delta); // frame-rate-independent damping
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
        const showHero = Math.max(0, 1 - progress / 0.5);
        const targetOpacity = Math.max(showHero, 0.05);
        const curOpacity = parseFloat(renderer.domElement.style.opacity || '1');
        renderer.domElement.style.opacity = String(lerp(curOpacity, targetOpacity, 0.06));
    } else if (renderer.domElement.style.opacity !== '1') {
        renderer.domElement.style.opacity = '1';
    }

    if (robot) {
        robot.position.x = curRobotX;
        robot.position.y = curRobotY + Math.sin(Date.now() * 0.0018) * 4; // idle breathing bob
        robot.rotation.y = curRotY + mouseX * 0.15;
        robot.rotation.x = mouseY * 0.06;

        // Live color/accessory cycle while the "Dein Bot, dein Stil" section
        // is in view. Bug fixed here: the active window used to end at
        // progress 2.6, but getSectionProgress() keeps counting up to ~3.0
        // while still inside that same section — so the cycle was silently
        // turning itself off (and resetting to the default look) for the
        // last ~40% of the time actually spent scrolled into that section.
        const styleActive = progress > 1.5 && progress < 3.15;
        if (styleActive && bodyBaseMat && bodyBlueMat) {
            styleLookTimer += delta;
            if (styleLookTimer > STYLE_LOOK_HOLD) {
                styleLookTimer = 0;
                styleLookIndex = (styleLookIndex + 1) % STYLE_LOOKS.length;
                const look = STYLE_LOOKS[styleLookIndex];
                targetColor.body.setHex(look.body);
                targetColor.blue.setHex(look.blue);
                applyAccessoryLook(look);
            }
            bodyBaseMat.color.lerp(targetColor.body, 0.04);
            bodyBlueMat.color.lerp(targetColor.blue, 0.04);
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
            bodyBaseMat.color.lerp(targetColor.body, 0.03);
            bodyBlueMat.color.lerp(targetColor.blue, 0.03);
            applyAccessoryLook(def);
        }
    }

    updateFace(performance.now());
    composer.render();
}

init();
animate();
