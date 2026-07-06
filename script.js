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
const clock = new THREE.Clock();
// Scroll state must live at module scope: animate() reads it every frame —
// declared inside init() it throws a ReferenceError that kills the whole
// render loop before composer.render(), leaving the background pure black.
let scrollY = 0;
let targetScrollY = 0;

function init() {
    const container = document.getElementById('webgl-container');

    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.set(0, 50, 400);
    
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x000000, 1); // Solid black for website background
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    // Environment Lighting
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    scene.environment = pmremGenerator.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(100, 200, 50);
    scene.add(dirLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // Composer
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.40, 0.4, 0.82);
    composer.addPass(bloomPass);

    // Real PBR maps, same set the app itself uses (FBX-embedded texture refs
    // have always been broken in this project — materials must be built by hand).
    const texLoader = new THREE.TextureLoader();
    const baseColorMap = texLoader.load('Textures/WheelBot_Body_BaseColor.png');
    baseColorMap.encoding = THREE.sRGBEncoding;
    const normalMap = texLoader.load('Textures/WheelBot_Body_Normal.png');
    const metalnessMap = texLoader.load('Textures/WheelBot_Body_Metallic.png');

    // Static friendly face for the hero bot — the desktop app animates its
    // eyes on a live canvas; here one hand-drawn frame of the same design
    // (two glowing rounded-square eyes on a dark screen) is plenty.
    function makeFaceTexture() {
        const c = document.createElement('canvas');
        c.width = c.height = 1024;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#04140a';
        ctx.fillRect(0, 0, 1024, 1024);
        [364.5, 659.5].forEach(cx => {
            ctx.save();
            ctx.shadowColor = 'rgba(25,242,255,0.9)';
            ctx.shadowBlur = 60;
            ctx.fillStyle = '#19f2ff';
            ctx.beginPath();
            ctx.roundRect(cx - 105, 512 - 105, 210, 210, 70);
            ctx.fill();
            ctx.restore();
        });
        const tex = new THREE.CanvasTexture(c);
        tex.encoding = THREE.sRGBEncoding;
        return tex;
    }
    const faceTex = makeFaceTexture();

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
        // spelling) — the previous lowercase check matched nothing, which left
        // VR glasses & co. floating around the hero bot. Hide everything
        // except the standard wheel, which is part of the default look.
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
        robot.position.set(-center.x * scale, (-center.y * scale) - 20, -center.z * scale);

        // Add idle animation
        if (robot.animations && robot.animations.length > 0) {
            mixer = new THREE.AnimationMixer(robot);
            const action = mixer.clipAction(robot.animations[0]);
            action.play();
        }

        scene.add(robot);
    });

    window.addEventListener('resize', onWindowResize);

    window.addEventListener('scroll', () => {
        targetScrollY = window.scrollY;
    });

    // Parallax effect on mouse move
    window.addEventListener('mousemove', (e) => {
        if (!robot) return;
        const mouseX = (e.clientX / window.innerWidth) * 2 - 1;
        const mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
        
        robot.rotation.y = mouseX * 0.3;
        robot.rotation.x = -mouseY * 0.1;
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.resolution.set(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    
    // Smooth scroll interpolation
    scrollY += (targetScrollY - scrollY) * 0.05;
    
    // Scroll percentage (0 to 1)
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    const scrollPercent = Math.max(0, Math.min(1, scrollY / maxScroll));
    
    if (camera) {
        // Cinematic camera sweep based on scroll
        // Starts at (0, 50, 400), sweeps down and around to (150, 100, 250)
        camera.position.x = Math.sin(scrollPercent * Math.PI) * 150;
        camera.position.y = 50 + scrollPercent * 50;
        camera.position.z = 400 - scrollPercent * 150;
        camera.lookAt(0, 50, 0);
    }
    
    // Floating animation — baseline sits well below the hero copy so the bot
    // hovers underneath the text instead of colliding with it.
    if (robot) {
        robot.position.y = (-135) + Math.sin(Date.now() * 0.0018) * 4;
    }

    composer.render();
}

function initMiniRenders() {
    function createMini(id, setupMaterials) {
        const container = document.getElementById(id);
        if (!container) return;

        const mScene = new THREE.Scene();
        const mCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 1000);
        mCamera.position.set(120, 80, 200);
        mCamera.lookAt(0, 40, 0);

        const mRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        mRenderer.setSize(container.clientWidth, container.clientHeight);
        mRenderer.outputEncoding = THREE.sRGBEncoding;
        container.appendChild(mRenderer.domElement);

        const aLight = new THREE.AmbientLight(0xffffff, 0.4);
        mScene.add(aLight);
        const dLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dLight.position.set(100, 200, 50);
        mScene.add(dLight);
        const bLight = new THREE.DirectionalLight(0x4fc3ff, 1.0);
        bLight.position.set(-100, 50, -50);
        mScene.add(bLight);

        let mRobot, mMixer;
        const loader = new THREE.FBXLoader();
        loader.load('wheelbot.fbx', function (object) {
            mRobot = object;
            setupMaterials(mRobot);

            const box = new THREE.Box3().setFromObject(mRobot);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const scale = 120 / Math.max(size.x, size.y, size.z);
            mRobot.scale.set(scale, scale, scale);
            mRobot.position.set(-center.x * scale, (-center.y * scale) - 10, -center.z * scale);

            if (mRobot.animations && mRobot.animations.length > 0) {
                mMixer = new THREE.AnimationMixer(mRobot);
                mMixer.clipAction(mRobot.animations[0]).play();
            }

            mScene.add(mRobot);
        });

        let clock = new THREE.Clock();
        function mAnimate() {
            requestAnimationFrame(mAnimate);
            if (mMixer) mMixer.update(clock.getDelta());
            if (mRobot) mRobot.rotation.y += 0.005;
            mRenderer.render(mScene, mCamera);
        }
        mAnimate();
    }

    createMini('render-smart', (r) => {
        // Glowing cyan base
        r.traverse(c => {
            if (!c.isMesh) return;
            c.material = new THREE.MeshPhysicalMaterial({ color: 0x111111, emissive: 0x00f2fe, emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.2 });
        });
    });

    createMini('render-style', (r) => {
        // Custom red and carbon look
        r.traverse(c => {
            if (c.name.startsWith('acessory_')) {
                if (c.name === 'acessory_VR_Glasses') c.visible = true;
                else c.visible = false;
            }
            if (!c.isMesh) return;
            const isBase = c.material && c.material.name && c.material.name.toLowerCase().includes('base');
            c.material = new THREE.MeshPhysicalMaterial({ color: isBase ? 0xff3333 : 0x222222, metalness: 0.9, roughness: 0.1 });
        });
    });

    createMini('render-light', (r) => {
        // Floating pure white glossy look
        r.traverse(c => {
            if (c.name.startsWith('acessory_')) c.visible = false;
            if (!c.isMesh) return;
            c.material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.1, roughness: 0.1, clearcoat: 1.0 });
        });
    });
}

init();
animate();
