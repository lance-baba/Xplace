import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { createSpectralOcean } from '../lib/spectral-ocean.js';

/* ============================================================
   SCENE ENGINE — ocean scene (our own implementation)
   Wave technique: spectral FFT module (MIT, noxellab/nagi-ocean-sim)
   - we use its displacement/normal textures as INPUT
   - surface shading, sky, palette, camera: our own engine design
   Sky photo: Poly Haven "Kloofendal 48d Partly Cloudy" (CC0-1.0)
   ============================================================ */

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;
  return((t^t>>>14)>>>0)/4294967296;}}

const qs = new URLSearchParams(location.search);
const styleName = qs.get('style') || 'summer';
const gameMode = qs.get('mode') !== 'cinema';
const forceWaves = qs.get('waves'); // spectral | gerstner

/* ---------------- style presets: style is data ---------------- */
const STYLES = {
  summer: {
    fog: [0xcfe0e8, 0.0058],
    hemi: [0xbfd8ff, 0x2a4a5a, 0.7],
    sun:  [0xfff2dd, 2.2, [7.5, 10, 5]],
    water: { deep:'#084a70', shallow:'#1f8f88', sky:'#bcdfee', foam:'#f2faf8' },
    seabed: { a:'#c8a86e', b:'#9a8055' },
    skyPhoto: '../assets-sky-base.jpg', skyExposure: 1.0,
    waveAmp: 1.0,
    fireflies: false,
  },
  storm: {
    fog: [0x5a6a72, 0.006],
    hemi: [0x5a6a80, 0x1a2028, 0.55],
    sun:  [0xcfd8e8, 1.1, [-6, 9, 4]],
    water: { deep:'#0a2a3e', shallow:'#1e5a5e', sky:'#7a8a98', foam:'#dfe8e6' },
    seabed: { a:'#5a5a52', b:'#3e3e3a' },
    skyPhoto: '../assets-sky-base.jpg', skyExposure: 0.5,
    waveAmp: 1.7,
    fireflies: false,
  },
  night: {
    fog: [0x0a1024, 0.006],
    hemi: [0x2a3a66, 0x0a0c10, 0.5],
    sun:  [0x9fb8ff, 0.8, [-8, 14, -4]],
    water: { deep:'#03101c', shallow:'#0d2a3e', sky:'#16263e', foam:'#9fb8cc' },
    seabed: { a:'#1e2a3a', b:'#121e2c' },
    skyPhoto: null, skyExposure: 1.0,
    waveAmp: 0.8,
    fireflies: false,
  },
};
const S = STYLES[styleName] || STYLES.summer;

const W=1280, H=720;
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(W,H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').prepend(renderer.domElement);
window.__boot && window.__boot('renderer');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(S.fog[0], S.fog[1]);
scene.add(new THREE.HemisphereLight(...S.hemi));
const sun = new THREE.DirectionalLight(S.sun[0], S.sun[1]);
sun.position.set(...S.sun[2]); scene.add(sun);
const sunDir = new THREE.Vector3(...S.sun[2]).normalize();

/* ---------------- sky dome: photo or procedural ---------------- */
let skyUniforms = null;
{
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSkyTex: { value: null },
      uExposure: { value: S.skyExposure },
      uUsePhoto: { value: S.skyPhoto ? 1 : 0 },
      uZenith: { value: new THREE.Color('#02030a') },
      uHorizon: { value: new THREE.Color('#162040') },
    },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D uSkyTex; uniform float uExposure, uUsePhoto, uTime;
      uniform vec3 uZenith, uHorizon;
      varying vec3 vDir;
      void main(){
        vec3 rd = normalize(vDir);
        vec3 col;
        if (uUsePhoto > 0.5) {
          vec2 uv = vec2(atan(rd.z, rd.x)/6.2831853 + 0.5,
                         asin(clamp(rd.y,-1.0,1.0))/3.14159265 + 0.5);
          col = texture2D(uSkyTex, uv).rgb * uExposure;
          col = mix(vec3(0.04,0.09,0.13)*uExposure, col, smoothstep(-0.06, 0.015, rd.y));
        } else {
          float y = max(rd.y, 0.0);
          col = mix(uHorizon, uZenith, pow(y, 0.5));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  skyUniforms = mat.uniforms;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 20), mat);
  dome.frustumCulled = false; dome.renderOrder = -10;
  scene.add(dome);
  if (S.skyPhoto) {
    new THREE.TextureLoader().load(S.skyPhoto, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      skyUniforms.uSkyTex.value = tex;
      if (typeof oceanUniforms !== 'undefined') {
        oceanUniforms.uSkyTex.value = tex;
        oceanUniforms.uSkyTexOn.value = 1;
      }
    });
  }
}

/* ---------------- spectral waves (FFT module) ---------------- */
let spectral = null;
let spectralError = '';
if (forceWaves !== 'gerstner') {
  try {
    spectral = createSpectralOcean(THREE, renderer);
    if (spectral) { spectral.update(0, 30, S.waveAmp); spectral.validate(); }
  } catch (e) { spectralError = String(e).slice(0, 200); console.warn('spectral unavailable, Gerstner fallback', e); spectral = null; }
}
const useSpectral = !!spectral;
window.__waveMode = useSpectral ? 'spectral FFT' : 'gerstner fallback' + (spectralError ? ' (' + spectralError + ')' : '');
window.__boot && window.__boot('waves:' + window.__waveMode);

/* ---------------- seabed: near-field detailed (rocks grown into heightfield) ---------------- */
// deterministic value noise for terrain (JS side)
function vnoise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const h = (a, b) => {
    let n = (Math.imul(a | 0, 0x9e3779b9) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    n ^= n >>> 16;
    return n / 4294967296;
  };
  return h(xi, zi) * (1 - u) * (1 - v) + h(xi + 1, zi) * u * (1 - v) +
         h(xi, zi + 1) * (1 - u) * v + h(xi + 1, zi + 1) * u * v;
}
function sstep(a, b, x) { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
// rocks: x, z, radiusX, radiusZ, peakHeight, rotation (grown into the heightfield, NAGI technique)
const ROCKS = [
  [10, -8, 3.4, 2.6, 2.6, 0.4], [-12, 6, 2.8, 2.2, 2.2, -0.5],
  [18, 10, 2.2, 1.8, 1.6, 0.9], [-18, -10, 3.0, 2.4, 2.3, 0.2],
  [5, 16, 2.4, 2.0, 1.8, -0.8], [-6, -18, 2.0, 1.6, 1.5, 0.6],
  [24, -14, 2.6, 2.0, 1.9, -0.2], [-24, 12, 2.2, 1.8, 1.6, 0.7],
  [0, -27, 3.2, 2.5, 2.4, 0.1], [30, 6, 2.0, 1.6, 1.4, -0.6],
  [-30, -4, 2.4, 1.9, 1.7, 0.3], [14, 25, 2.8, 2.2, 2.0, -0.4],
  [-16, 23, 2.2, 1.7, 1.6, 0.8], [38, -8, 3.0, 2.3, 2.1, 0.5],
  [-38, 8, 2.6, 2.0, 1.8, -0.3],
];
function rockField(x, z) {
  let h = 0, mask = 0;
  for (const [cx, cz, rx, rz, peak, ang] of ROCKS) {
    const dx = x - cx, dz = z - cz;
    const R = Math.max(rx, rz) * 1.8;
    if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
    const c = Math.cos(ang), sn = Math.sin(ang);
    const u = (c * dx + sn * dz) / rx, v = (-sn * dx + c * dz) / rz;
    const q = u * u + v * v;
    if (q > 2.5) continue;
    const erosion = 0.38 * (vnoise2(x * 0.65 + cx * 1.7, z * 0.65 + cz * 1.3) - 0.5);
    const body = Math.pow(Math.max(1 - q + erosion, 0), 1.3);
    const n = vnoise2(x * 1.2 + cx * 2.7, z * 1.2 + cz * 1.9);
    const hh = peak * body * (0.80 + 0.40 * n);
    if (hh > h) h = hh;
    const m = 1 - Math.min(Math.max((q - 0.5) / 0.7, 0), 1);
    if (m > mask) mask = m;
  }
  return [h, mask > 1 ? 1 : mask];
}
function seabedH(x, z) {
  return Math.sin(x * 0.08) * Math.cos(z * 0.06) * 1.2
       + Math.sin(x * 0.23 + z * 0.19) * 0.5
       + rockField(x, z)[0];
}
const SEABED_Y = -3.5;
let seabedUniforms = null;
const GLSL_NOISE = `
float vnhash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(vnhash(i), vnhash(i + vec2(1.,0.)), u.x),
             mix(vnhash(i + vec2(0.,1.)), vnhash(i + vec2(1.,1.)), u.x), u.y);
}`;
{
  // near-field 230m, dense enough for rock mounds; edge feathered to meet far plane
  const EXT = 190, SEG = 380, HALF = EXT / 2;
  const g = new THREE.PlaneGeometry(EXT, EXT, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const rockAttr = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const rf = rockField(x, z);
    let y = Math.sin(x*0.08)*Math.cos(z*0.06)*1.2 + Math.sin(x*0.23+z*0.19)*0.5 + rf[0];
    const ex = Math.max(Math.abs(x), Math.abs(z));
    y -= sstep(80, HALF, ex) * 0.6;
    p.setY(i, y);
    rockAttr[i] = rf[1] * (1 - sstep(80, HALF, ex));
  }
  g.setAttribute('aRock', new THREE.BufferAttribute(rockAttr, 1));
  g.computeVertexNormals();
  seabedUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uTime: { value: 0 },
      uSandA: { value: new THREE.Color(S.seabed.a) },
      uSandB: { value: new THREE.Color(S.seabed.b) } },
  ]);
  const m = new THREE.ShaderMaterial({
    uniforms: seabedUniforms,
    fog: true,
    vertexShader: `
      #include <fog_pars_vertex>
      attribute float aRock;
      varying vec3 vWp; varying float vRock; varying vec3 vNw;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWp = wp.xyz; vRock = aRock;
        vNw = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uSandA, uSandB;
      varying vec3 vWp; varying float vRock; varying vec3 vNw;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vWp.xz;
        float rip = sin(p.x*0.55 + sin(p.y*0.4)*1.5) * sin(p.y*0.5 + 1.7);
        vec3 sand = mix(uSandA, uSandB, rip*0.5 + 0.5);
        float grain = vnoise(p*2.2)*0.45 + vnoise(p*6.5)*0.35 + vnoise(p*16.0)*0.20;
        sand *= 0.88 + 0.24 * grain;
        float patchN = vnoise(p*0.11 + 7.3);
        sand *= 0.93 + 0.14 * patchN;
        float st = vnoise(p*1.4)*0.6 + vnoise(p*4.2)*0.4;
        vec3 stone = mix(vec3(0.055,0.055,0.05), vec3(0.15,0.145,0.13), st);
        stone = mix(stone, sand*0.92, smoothstep(0.72, 0.95, normalize(vNw).y) * 0.35);
        float rockM = smoothstep(0.12, 0.72, vRock);
        vec3 col = mix(sand, stone, rockM);
        vec2 q = p * 0.16; float t = uTime * 0.6;
        float c1 = sin(q.x*3.1 + t) * sin(q.y*2.7 - t*0.8);
        float c2 = sin((q.x+q.y)*2.3 - t*0.6) * sin((q.x-q.y)*2.9 + t*0.5);
        float ca = pow(clamp((c1+c2)*0.25 + 0.5, 0.0, 1.0), 7.0);
        col += vec3(0.45, 0.8, 0.85) * ca * 0.6 * (1.0 - 0.45*rockM);
        float d = clamp(length(p) / 520.0, 0.0, 1.0);
        col *= 1.0 - d * 0.35;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const seabed = new THREE.Mesh(g, m);
  seabed.position.y = SEABED_Y;
  scene.add(seabed);
}
{
  // far-field: simple dunes only, sunk 0.6m to avoid z-fighting under the near mesh
  const g = new THREE.PlaneGeometry(1200, 1200, 48, 48);
  g.rotateX(-Math.PI/2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++)
    p.setY(i, Math.sin(p.getX(i)*0.08)*Math.cos(p.getZ(i)*0.06)*1.2 + Math.sin(p.getX(i)*0.23+p.getZ(i)*0.19)*0.5);
  g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    uniforms: seabedUniforms,
    fog: true,
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec3 vWp;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWp = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 uSandA, uSandB;
      varying vec3 vWp;
      void main(){
        vec2 p = vWp.xz;
        float rip = sin(p.x*0.55 + sin(p.y*0.4)*1.5) * sin(p.y*0.5 + 1.7);
        vec3 col = mix(uSandA, uSandB, rip*0.5 + 0.5);
        float d = clamp(length(p) / 520.0, 0.0, 1.0);
        col *= 1.0 - d * 0.35;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const far = new THREE.Mesh(g, m);
  far.position.y = SEABED_Y - 0.6;
  scene.add(far);
}
/* seagrass: dark olive ribbons clustered around rocks */
let seagrassUniforms = null;
{
  const N = 520;
  const bg = new THREE.PlaneGeometry(0.14, 1.15, 1, 4);
  bg.translate(0, 0.57, 0);
  const bp = bg.attributes.position, buv = bg.attributes.uv;
  for (let i = 0; i < bp.count; i++) bp.setX(i, bp.getX(i) * (1 - buv.getY(i) * 0.85));
  seagrassUniforms = { uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: seagrassUniforms,
    side: THREE.DoubleSide,
    vertexShader: `
      uniform float uTime;
      varying float vH; varying float vShade;
      void main(){
        vH = uv.y;
        vec4 ip = instanceMatrix * vec4(0.,0.,0.,1.);
        float ph = ip.x * 1.3 + ip.z * 1.7;
        vShade = 0.7 + 0.6 * fract(sin(dot(floor(ip.xz), vec2(12.9898,78.233))) * 43758.5453);
        vec3 tp = position;
        float bend = uv.y * uv.y;
        tp.x += sin(uTime*1.4 + ph) * 0.30 * bend;
        tp.z += cos(uTime*1.05 + ph*1.3) * 0.18 * bend;
        vec4 wp = modelMatrix * instanceMatrix * vec4(tp, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying float vH; varying float vShade;
      void main(){
        vec3 col = mix(vec3(0.05,0.10,0.04), vec3(0.16,0.24,0.08), vH) * vShade;
        col += vec3(0.05,0.09,0.02) * vH * vH;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const inst = new THREE.InstancedMesh(bg, mat, N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const pv = new THREE.Vector3(), sv = new THREE.Vector3();
  const R = mulberry32(77);
  for (let i = 0; i < N; i++) {
    const rk = ROCKS[(R() * ROCKS.length) | 0];
    const a = R() * Math.PI * 2, rr = 1.5 + R() * R() * 7;
    const x = rk[0] + Math.cos(a) * rr, z = rk[1] + Math.sin(a) * rr;
    e.set((R()-0.5)*0.25, R() * Math.PI * 2, (R()-0.5)*0.25); q.setFromEuler(e);
    const s = 0.6 + R() * 1.0;
    pv.set(x, SEABED_Y + seabedH(x, z) - 0.05, z); sv.set(s, s*(0.8+R()*0.5), s);
    m4.compose(pv, q, sv); inst.setMatrixAt(i, m4);
  }
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

/* ---------------- ocean surface: OUR shader ---------------- */
const oceanUniforms = {
  uTime: { value: 0 },
  uUseSpectral: { value: useSpectral ? 1 : 0 },
  uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
  uNrm0: { value: null },
  uDeep: { value: new THREE.Color(S.water.deep) },
  uShallow: { value: new THREE.Color(S.water.shallow) },
  uSkyCol: { value: new THREE.Color(S.water.sky) },
  uFoamCol: { value: new THREE.Color(S.water.foam) },
  uSunDir: { value: sunDir },
  uSunColor: { value: new THREE.Color(S.sun[0]) },
  uSeabedTex: { value: null },
  uResolution: { value: new THREE.Vector2(W, H) },
  uFogColor: { value: new THREE.Color(S.fog[0]) },
  uFogDensity: { value: S.fog[1] },
  uSkyTex: { value: null },
  uSkyTexOn: { value: 0 },
};
function bindSpectral() {
  if (!spectral) return;
  const [a, b, c] = spectral.cascades;
  oceanUniforms.uDisp0.value = a.output.textures[0];
  oceanUniforms.uDisp1.value = b.output.textures[0];
  oceanUniforms.uDisp2.value = c.output.textures[0];
  oceanUniforms.uNrm0.value = a.output.textures[1];
}
bindSpectral();
{
  const g = new THREE.PlaneGeometry(320, 320, 220, 220);
  g.rotateX(-Math.PI/2);
  const m = new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    vertexShader: `
      uniform sampler2D uDisp0, uDisp1, uDisp2, uNrm0;
      uniform float uTime, uUseSpectral;
      varying vec3 vWp; varying vec2 vRest; varying float vH; varying float vFoam;
      // Gerstner fallback (no float render targets)
      vec3 gerstner(vec2 p, out vec3 nrm, out float foam) {
        vec3 disp = vec3(0.0); nrm = vec3(0.0, 1.0, 0.0); foam = 0.0;
        float dirs[5]; float steep[5]; float wl[5];
        // unrolled 5 waves
        vec2 D[5]; float A[5]; float L[5]; float Q[5]; float SP[5];
        D[0]=normalize(vec2(1.0,0.3));  A[0]=0.55; L[0]=28.0; Q[0]=0.6; SP[0]=1.0;
        D[1]=normalize(vec2(0.7,-0.7)); A[1]=0.32; L[1]=13.0; Q[1]=0.6; SP[1]=1.2;
        D[2]=normalize(vec2(-0.4,0.9)); A[2]=0.18; L[2]=7.0;  Q[2]=0.5; SP[2]=1.4;
        D[3]=normalize(vec2(0.9,0.5));  A[3]=0.10; L[3]=3.7;  Q[3]=0.5; SP[3]=1.6;
        D[4]=normalize(vec2(-0.8,-0.2));A[4]=0.06; L[4]=1.9;  Q[4]=0.4; SP[4]=1.8;
        for (int i = 0; i < 5; i++) {
          float k = 6.28318 / L[i];
          float f = k * (dot(D[i], p) - sqrt(9.8 * k) * uTime * SP[i]);
          float a = Q[i] * A[i];
          disp.x += D[i].x * a * cos(f);
          disp.z += D[i].y * a * cos(f);
          disp.y += A[i] * sin(f);
          foam += A[i] * k * max(0.0, sin(f + 1.2));
        }
        // numeric normal
        float e = 0.35;
        vec3 px = disp; // approx via re-eval skipped: use analytic-ish
        nrm = normalize(vec3(-disp.x * 0.8, 1.0, -disp.z * 0.8));
        return disp;
      }
      void main() {
        vec2 rest = position.xz;
        vRest = rest;
        vec3 tp; vec3 nrmI; float foamI;
        if (uUseSpectral > 0.5) {
          vec4 a = texture2D(uDisp0, rest/1024.0 + 0.5);
          vec2 q = rest + a.yz;
          vec4 b = texture2D(uDisp1, q/96.0 + 0.5);
          vec2 q2 = q + b.yz;
          vec4 c = texture2D(uDisp2, q2/9.0 + 0.5);
          float h = a.x + b.x + c.x;
          vec2 xz = rest + (a.yz + b.yz + c.yz);
          tp = vec3(xz.x, h, xz.y);
          vH = h;
          vFoam = 1.0 - texture2D(uNrm0, rest/1024.0 + 0.5).w;
        } else {
          vec3 nrm; float fm;
          vec3 d = gerstner(rest, nrm, fm);
          tp = vec3(rest.x + d.x, d.y, rest.y + d.z);
          vH = d.y; vFoam = fm * 0.5;
        }
        vec4 wp = modelMatrix * vec4(tp, 1.0);
        vWp = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uDeep, uShallow, uSkyCol, uFoamCol, uSunDir, uSunColor, uFogColor;
      uniform sampler2D uNrm0, uSeabedTex, uSkyTex; uniform vec2 uResolution;
      uniform float uUseSpectral, uTime, uFogDensity, uSkyTexOn;
      varying vec3 vWp; varying vec2 vRest; varying float vH; varying float vFoam;
      float hash(vec2 p){ vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453),
                       fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453),f.x),
                   mix(fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453),
                       fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453),f.x),f.y); }
      void main() {
        vec3 n;
        if (uUseSpectral > 0.5) {
          n = normalize(texture2D(uNrm0, vRest/1024.0 + 0.5).xyz * 2.0 - 1.0);
        } else {
          n = normalize(cross(dFdx(vWp), dFdy(vWp)));
        }
        if (!gl_FrontFacing) n = -n;
        vec3 V = normalize(cameraPosition - vWp);
        // refracted seabed (technique learned from nagi-ocean-sim: sample the
        // underwater scene with a wave-normal UV offset instead of alpha blend)
        vec2 scuv = gl_FragCoord.xy / uResolution;
        vec2 roff = n.xz * 0.04;
        vec2 suv = scuv + roff;
        suv.y = min(suv.y, scuv.y); // refracted ray can only hit below: never sample sky
        vec3 behind = texture2D(uSeabedTex, clamp(suv, 0.001, 0.999)).rgb;
        // Schlick fresnel: clear looking down, mirror at grazing angles
        float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, n), 0.0), 5.0);
        float frefl = min(F * 1.25, 0.88);
        // slight water-body absorption on the transmitted light
        vec3 transm = behind * mix(vec3(1.0), uDeep * 2.0 + 0.35, 0.28);
        // water volume: height gradient + sun shading so waves read
        vec3 vol = mix(uDeep, uShallow, smoothstep(-1.1, 1.7, vH));
        vol *= 0.45 + 0.55 * max(dot(n, normalize(uSunDir)), 0.0);
        // far water can't show the bottom: fade transmitted term with distance,
        // leaving pure fresnel sky reflection (also kills invalid sky samples)
        float fogDepth = distance(cameraPosition, vWp);
        float transmW = 0.62 * (1.0 - smoothstep(60.0, 150.0, fogDepth));
        vec3 col = mix(vol, transm, transmW);
        // analytic sky gradient reflection (smooth, controllable, no seams)
        vec3 R = reflect(-V, n);
        float ry = clamp(R.y, 0.0, 1.0);
        vec3 zen = mix(uSkyCol, vec3(0.13, 0.32, 0.62), 0.65);
        vec3 hor = mix(uSkyCol, vec3(0.92, 0.95, 0.98), 0.18);
        vec3 skyRef = mix(hor, zen, pow(ry, 0.5));
        col = mix(col, skyRef, frefl * 0.92);
        // sun glitter
        vec3 H = normalize(V + normalize(uSunDir));
        vec3 glit = uSunColor * pow(max(dot(n, H), 0.0), 220.0) * 1.4;
        if (gl_FragCoord.x < uResolution.x * 0.5) { gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return; }
        col += glit;
        // foam: crest compression + breakup, fades with distance
        float brk = hash(floor(vWp.xz * 11.0) + floor(uTime * 2.0) * 0.13);
        float foam = smoothstep(0.42, 0.8, vFoam * 0.75 + smoothstep(0.5, 1.9, vH) * 0.45 + (brk - 0.5) * 0.18);
        foam *= 1.0 - smoothstep(25.0, 70.0, distance(cameraPosition, vWp));
        col = mix(col, uFoamCol, foam);
        // distance fog (matches scene FogExp2) so far water melts into horizon
        float fogF = 1.0 - exp(-uFogDensity * uFogDensity * fogDepth * fogDepth);
        col = mix(col, uFogColor, fogF);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const ocean = new THREE.Mesh(g, m);
  ocean.frustumCulled = false;
  scene.add(ocean);
  window.__boot && window.__boot('ocean mesh');
  window.__oceanMesh = ocean;
}

/* refraction pass: render underwater scene to target (technique from nagi-ocean-sim) */
const refrTarget = new THREE.WebGLRenderTarget(W, H, {
  type: renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  depthBuffer: true, stencilBuffer: false,
});
oceanUniforms.uSeabedTex.value = refrTarget.texture;

/* ---------------- camera: game vs cinema ---------------- */
const camera = new THREE.PerspectiveCamera(50, W/H, 0.1, 900);
let controls = null;
if (gameMode) {
  camera.position.set(16, 9, 22);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0); controls.update();
  controls.maxPolarAngle = Math.PI * 0.495;
  document.getElementById('hint').textContent = `ocean · style=${styleName} · ${window.__waveMode} · drag to orbit`;
} else {
  document.getElementById('hint').textContent = '';
}

/* ---------------- deterministic frame ---------------- */
const fadeEl = document.getElementById('fade');
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = x => { x = clamp01(x); return x*x*(3-2*x); };

window.renderFrame = function(t) {
  if (!window.__firstFrame) { window.__firstFrame = true; window.__boot && window.__boot('first frame'); }
  if (spectral) spectral.update(t, 30, S.waveAmp);
  oceanUniforms.uTime.value = t;
  if (seabedUniforms) seabedUniforms.uTime.value = t;
  if (seagrassUniforms) seagrassUniforms.uTime.value = t;
  if (skyUniforms) skyUniforms.uTime.value = t;
  if (!gameMode) {
    const a = t * 0.12 + 0.8;
    const R = 26 - t * 0.5;
    camera.position.set(Math.cos(a)*R, 8.5 - t*0.3, Math.sin(a)*R);
    camera.lookAt(0, 1.2, 0);
  } else if (controls) controls.update();
  // refraction pass: underwater scene without water surface
  const oceanMesh = window.__oceanMesh;
  oceanMesh.visible = false;
  renderer.setRenderTarget(refrTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  oceanMesh.visible = true;
  renderer.render(scene, camera);
  fadeEl.style.opacity = gameMode ? 0 : 1 - Math.min(smooth(t/0.7), smooth((5-t)/0.7));
};
window.renderFrame(0);
window.sceneReady = true;
window.__camera = camera; window.__controls = controls; window.__scene = scene;
if (gameMode) {
  const clock = new THREE.Clock();
  (function animate(){ requestAnimationFrame(animate); window.renderFrame(clock.getElapsedTime()); })();
}
