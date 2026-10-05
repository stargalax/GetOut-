import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Small 3D low-poly person that walks back and forth along the bottom.
 *
 * Props:
 *  height  - canvas height in px (figure takes ~75% of it)
 *  speed   - walking speed (world units / sec)
 *  shirt, pants, skin, hair, shoes - colors (hex strings)
 *  fixed   - true: pinned to bottom of the viewport (home screen)
 *            false: sits inline in its parent (loading screens)
 */
export default function WalkingFigure({
    height = 160,
    speed = 1.1,
    shirt = "#ff8f7a",
    pants = "#6b5bea",
    skin = "#f2b88f",
    hair = "#2b1d14",
    shoes = "#ffd75e",
    fixed = true,
}) {
    const mountRef = useRef(null);

    useEffect(() => {
        const el = mountRef.current;
        if (!el) return;

        const reduceMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
        ).matches;

        // ---------- renderer / camera ----------
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        el.appendChild(renderer.domElement);
        renderer.domElement.style.display = "block";

        const scene = new THREE.Scene();
        const viewH = 2.8;
        const camera = new THREE.OrthographicCamera(-1, 1, viewH / 2, -viewH / 2, 0.1, 50);
        camera.position.set(0, 2.4, 10);
        camera.lookAt(0, 1.1, 0);

        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(3, 6, 5);
        scene.add(sun);

        // ---------- figure ----------
        const std = (c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.8 });
        const mShirt = std(shirt);
        const mPants = std(pants);
        const mSkin = std(skin);
        const mHair = std(hair);
        const mShoes = std(shoes);
        const dark = std("#222230");
        const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

        const root = new THREE.Group();
        scene.add(root);
        const body = new THREE.Group();
        root.add(body);

        const torso = box(0.5, 0.65, 0.28, mShirt);
        torso.position.y = 1.33;
        body.add(torso);

        const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), mSkin);
        head.position.y = 1.9;
        body.add(head);

        // hair cap (top half of a slightly bigger sphere, tilted back)
        const hairMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.215, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
            mHair
        );
        hairMesh.position.y = 1.91;
        hairMesh.rotation.x = -0.25;
        body.add(hairMesh);

        const nose = box(0.06, 0.06, 0.1, mSkin); // shows which way it faces
        nose.position.set(0, 1.88, 0.2);
        body.add(nose);
        [-0.07, 0.07].forEach((ex) => {
            const eye = box(0.04, 0.05, 0.03, dark);
            eye.position.set(ex, 1.94, 0.19);
            body.add(eye);
        });

        // limb: upper part in `mainMat`, tip (hand/shoe) in `tipMat`
        const limb = (w, h, d, px, py, mainMat, tipMat, tipH) => {
            const pivot = new THREE.Group();
            pivot.position.set(px, py, 0);
            const main = box(w, h - tipH, d, mainMat);
            main.position.y = -(h - tipH) / 2;
            pivot.add(main);
            const tip = box(w * (tipMat === mShoes ? 1.1 : 1), tipH, d * (tipMat === mShoes ? 1.5 : 1), tipMat);
            tip.position.y = -(h - tipH) - tipH / 2;
            if (tipMat === mShoes) tip.position.z = d * 0.25;
            pivot.add(tip);
            body.add(pivot);
            return pivot;
        };
        const legL = limb(0.18, 0.95, 0.2, -0.13, 1.0, mPants, mShoes, 0.14);
        const legR = limb(0.18, 0.95, 0.2, 0.13, 1.0, mPants, mShoes, 0.14);
        const armL = limb(0.13, 0.6, 0.15, -0.34, 1.6, mShirt, mSkin, 0.14);
        const armR = limb(0.13, 0.6, 0.15, 0.34, 1.6, mShirt, mSkin, 0.14);

        const shadow = new THREE.Mesh(
            new THREE.CircleGeometry(0.4, 20),
            new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.01;
        root.add(shadow);

        // ---------- sizing ----------
        let halfW = 3;
        const resize = () => {
            const w = el.clientWidth || window.innerWidth;
            const h = el.clientHeight || height;
            renderer.setSize(w, h, false);
            renderer.domElement.style.width = "100%";
            renderer.domElement.style.height = "100%";
            halfW = (viewH * (w / h)) / 2;
            camera.left = -halfW;
            camera.right = halfW;
            camera.updateProjectionMatrix();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(el);

        // ---------- animation ----------
        let dir = 1;
        let x = -halfW + 0.6;
        let rotY = Math.PI / 2 - 0.4;
        let phase = 0;
        let last = performance.now();
        let raf;

        const tick = (now) => {
            const dt = Math.min((now - last) / 1000, 0.05);
            last = now;

            if (!reduceMotion) {
                x += dir * speed * dt;
                if (x > halfW - 0.6) dir = -1;
                if (x < -halfW + 0.6) dir = 1;
                phase += dt * speed * 6;
            }

            // ease the turn-around
            const targetRot = dir > 0 ? Math.PI / 2 - 0.4 : -Math.PI / 2 + 0.4;
            rotY += (targetRot - rotY) * Math.min(dt * 6, 1);

            const swing = reduceMotion ? 0 : Math.sin(phase);
            legL.rotation.x = swing * 0.7;
            legR.rotation.x = -swing * 0.7;
            armL.rotation.x = -swing * 0.6;
            armR.rotation.x = swing * 0.6;
            body.position.y = Math.abs(Math.cos(phase)) * 0.05;
            torso.rotation.y = swing * 0.08;

            root.position.x = x;
            root.rotation.y = rotY;
            shadow.rotation.z = 0;

            renderer.render(scene, camera);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        // ---------- cleanup ----------
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            scene.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            renderer.dispose();
            if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement);
        };
    }, [height, speed, shirt, pants, skin, hair, shoes]);

    const style = fixed
        ? { position: "fixed", left: 0, right: 0, bottom: 0, height, pointerEvents: "none", zIndex: 10 }
        : { position: "relative", width: "100%", height, pointerEvents: "none" };

    return <div ref={mountRef} style={style} aria-hidden="true" />;
}