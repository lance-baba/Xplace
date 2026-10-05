
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================================================
   SCENE ENGINE v0.1 — core + style presets + dual output
   Grass wind method learned from:
   https://github.com/Steve245270533/three-stylized (MIT)
   - instanced blades, world-space sine wind masked by tip^2,
     bottom->top gradient, sun backlight transmission.
   ============================================================ */

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;
  return((t^t>>>14)>>>0)/4294967296;}}
const rnd = mulberry32(20261004);
// deterministic value noise (JS side, for terrain)
function vnoise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const h = (a, b) => {
    let n = (Math.imul(a | 0, 0x9e3779b9) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
    n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  return h(xi, zi) * (1 - u) * (1 - v) + h(xi + 1, zi) * u * (1 - v) +
         h(xi, zi + 1) * (1 - u) * v + h(xi + 1, zi + 1) * u * v;
}
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

const qs = new URLSearchParams(location.search);
const styleName = qs.get('style') || 'summer';
const gameMode = qs.get('mode') !== 'cinema'; // default: live browser program

/* ---------------- style presets: style is data ---------------- */
const STYLES = {
  summer: { // 菊次郎的夏天
    fog: [0xd8ecd8, 0.0075],
    hemi: [0xbfd8ff, 0x8a7a5a, 0.85],
    sun:  [0xfff0d0, 2.0, [9, 15, 6]],
    terrain: 0x5d8a3c,
    grass: { bottom:'#3f7011', top:'#a4c452', backlight:'#d8f060' },
    trunk: 0x7a5230, leaf: [0x5da53a, 0x74c04a, 0x4c9334],
    fireflies: false,
    sky: { zenith:'#2e6ab5', horizon:'#d4ecf4', sun:'#fff3d2' },
    cloud: { cover: 0.42, color:'#ffffff' },
    water: { deep:'#14617f', shallow:'#62c2ae', sky:'#bfe3f2' },
    skyPhoto: '../assets-sky-base.jpg', skyExposure: 1.0,
  },
  night: {
    fog: [0x0a1024, 0.010],
    hemi: [0x2a3a66, 0x0a0c10, 0.5],
    sun:  [0x9fb8ff, 0.7, [-8, 14, -4]],
    terrain: 0x1d2f22,
    grass: { bottom:'#0e2412', top:'#2e5a34', backlight:'#4a7a5a' },
    trunk: 0x2a2018, leaf: [0x14301c, 0x1a3d24, 0x102418],
    fireflies: true,
    sky: { zenith:'#02030a', horizon:'#162040', sun:'#8fa8ff' },
    cloud: { cover: 0.30, color:'#5a6a9a' },
    water: { deep:'#04121e', shallow:'#0e2a3a', sky:'#1a2a4a' },
    skyPhoto: null, skyExposure: 1.0,
  },
};
const S = STYLES[styleName] || STYLES.summer;

const W=1280, H=720;
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(W,H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(S.fog[0], S.fog[1]);

scene.add(new THREE.HemisphereLight(...S.hemi));
const sun = new THREE.DirectionalLight(S.sun[0], S.sun[1]);
sun.position.set(...S.sun[2]); scene.add(sun);
const sunDir = new THREE.Vector3(...S.sun[2]).normalize();

{ // sky dome: photo (summer) or procedural fbm clouds (night)
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSkyTex: { value: null },
      uExposure: { value: S.skyExposure },
      uUsePhoto: { value: S.skyPhoto ? 1 : 0 },
      uZenith: { value: new THREE.Color(S.sky.zenith) },
      uHorizon: { value: new THREE.Color(S.sky.horizon) },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(S.sky.sun) },
      uCloudColor: { value: new THREE.Color(S.cloud.color) },
      uCloudCover: { value: S.cloud.cover },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){ vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime, uCloudCover, uExposure, uUsePhoto;
      uniform vec3 uZenith, uHorizon, uSunDir, uSunColor, uCloudColor;
      uniform sampler2D uSkyTex;
      varying vec3 vDir;
      float hash(vec2 p){ vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453);
        float b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453);
        float c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453);
        float d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453);
        return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
      float fbm(vec2 p){ float v=0.,a=.5;
        for(int i=0;i<4;i++){ v+=a*hash(p); p=mat2(.8,.6,-.6,.8)*p*2.03; a*=.5; } return v; }
      void main(){
        vec3 rd = normalize(vDir);
        vec3 col;
        if (uUsePhoto > 0.5) {
          vec2 uv = vec2(atan(rd.z, rd.x)/6.2831853 + 0.5,
                         asin(clamp(rd.y,-1.0,1.0))/3.14159265 + 0.5);
          col = texture2D(uSkyTex, uv).rgb * uExposure;
          col = mix(uHorizon*0.55, col, smoothstep(-0.06, 0.015, rd.y));
        } else {
          float y = max(rd.y, 0.0);
          col = mix(uHorizon, uZenith, pow(y, 0.55));
          float s = max(dot(rd, normalize(uSunDir)), 0.0);
          col += uSunColor * pow(s, 350.0) * 1.4;
          col += uSunColor * pow(s, 8.0) * 0.22;
          vec2 cp = rd.xz / (y + 0.18);
          float layer = fbm(cp * vec2(1.1, 2.2) + vec2(uTime*0.010, uTime*0.002));
          float cover = smoothstep(1.0-uCloudCover-0.28, 1.0-uCloudCover+0.28, layer);
          cover *= smoothstep(0.0, 0.12, y);
          vec3 cloudCol = uCloudColor * (0.72 + 0.45*pow(s, 3.0)) * (0.82 + 0.36*layer);
          col = mix(col, cloudCol, cover*0.92);
          col = mix(uHorizon*0.92, col, smoothstep(-0.06, 0.015, rd.y));
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 20), skyMat);
  skyDome.frustumCulled = false;
  scene.add(skyDome);
  window.__skyUniforms = skyMat.uniforms;
  if (S.skyPhoto) {
    new THREE.TextureLoader().load(S.skyPhoto, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      skyMat.uniforms.uSkyTex.value = tex;
    });
  }
}

/* ---------------- terrain + pond basin ---------------- */
const POND = { x: 8.5, z: 4.5, r: 3.6 };
const WATER_Y = -0.5;
const sstep = (a,b,x)=>{ const t=Math.min(1,Math.max(0,(x-a)/(b-a))); return t*t*(3-2*t); };
// rock outcrops grown into the terrain (same technique as ocean seabed)
const TROCKS = [
  [12, 1, 1.1, 0.9, 0.75, 0.4], [-7, -4, 1.4, 1.1, 0.95, -0.5],
  [3, -9.5, 0.8, 0.7, 0.55, 0.9], [-3.5, 7.5, 0.9, 0.75, 0.6, 0.2],
  [10, -3, 0.7, 0.6, 0.45, -0.8], [-11, 5, 1.2, 1.0, 0.8, 0.6],
  [6, 9, 0.85, 0.7, 0.55, -0.3],
];
function trockField(x, z) {
  let h = 0, mask = 0;
  for (const [cx, cz, rx, rz, peak, ang] of TROCKS) {
    const dx = x - cx, dz = z - cz;
    const R = Math.max(rx, rz) * 1.8;
    if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
    const c = Math.cos(ang), sn = Math.sin(ang);
    const u = (c * dx + sn * dz) / rx, v = (-sn * dx + c * dz) / rz;
    const q = u * u + v * v;
    if (q > 2.5) continue;
    const erosion = 0.38 * (vnoise2(x * 1.4 + cx * 1.7, z * 1.4 + cz * 1.3) - 0.5);
    const body = Math.pow(Math.max(1 - q + erosion, 0), 1.3);
    const n = vnoise2(x * 2.4 + cx * 2.7, z * 2.4 + cz * 1.9);
    const hh = peak * body * (0.80 + 0.40 * n);
    if (hh > h) h = hh;
    const m = 1 - Math.min(Math.max((q - 0.5) / 0.7, 0), 1);
    if (m > mask) mask = m;
  }
  return [h, mask > 1 ? 1 : mask];
}
function terrainH(x,z){
  const d = Math.hypot(x-POND.x, z-POND.z);
  // rolling hills, two octaves
  let h = 1.7 * vnoise2(x*0.075+3.1, z*0.075-1.7) + 0.55 * vnoise2(x*0.23-5.2, z*0.23+2.8);
  h = (h - 1.12) * 2.0;
  h *= 0.25 + 0.75*sstep(2.0, 7.0, d);          // flatten near pond
  h -= 1.3 * (1 - sstep(3.0, 5.5, d));        // basin
  h += trockField(x, z)[0];                   // rock outcrops
  return h;
}
let terrainUniforms = null;
{
  // RingGeometry: interior vertices for displacement; larger for real hills
  const g = new THREE.RingGeometry(0.01, 30, 128, 48);
  g.rotateX(-Math.PI/2);
  const p = g.attributes.position;
  const rockAttr = new Float32Array(p.count);
  for(let i=0;i<p.count;i++){
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, terrainH(x, z));
    rockAttr[i] = trockField(x, z)[1];
  }
  g.setAttribute('aRock', new THREE.BufferAttribute(rockAttr, 1));
  g.computeVertexNormals();
  terrainUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(S.sun[0]).multiplyScalar(S.sun[1] * 0.55) },
      uHemiSky: { value: new THREE.Color(S.hemi[0]) },
      uHemiGround: { value: new THREE.Color(S.hemi[1]) },
      uHemiInt: { value: S.hemi[2] * 0.6 },
      uGrassA: { value: new THREE.Color('#4a7a28') },  // lush
      uGrassB: { value: new THREE.Color('#8aa04a') },  // dry
      uDirt: { value: new THREE.Color('#7a6248') },
      uPond: { value: new THREE.Vector3(POND.x, POND.z, POND.r) },
    },
  ]);
  const m = new THREE.ShaderMaterial({
    uniforms: terrainUniforms,
    fog: true,
    vertexShader: `
      #include <fog_pars_vertex>
      attribute float aRock;
      varying vec3 vWp; varying vec3 vNw; varying float vRock;
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
      uniform float uTime, uHemiInt;
      uniform vec3 uSunDir, uSunColor, uHemiSky, uHemiGround;
      uniform vec3 uGrassA, uGrassB, uDirt, uPond;
      varying vec3 vWp; varying vec3 vNw; varying float vRock;
      ${GLSL_NOISE}
      void main(){
        vec2 p = vWp.xz;
        vec3 N = normalize(vNw);
        // grass: large lush/dry patches + grain
        float patch1 = vnoise(p*0.09);
        float patch2 = vnoise(p*0.33 + 4.7);
        vec3 alb = mix(uGrassA, uGrassB, clamp(patch1*0.7+patch2*0.3, 0.0, 1.0));
        alb *= 0.88 + 0.24 * (vnoise(p*1.8)*0.5 + vnoise(p*5.5)*0.3 + vnoise(p*14.0)*0.2);
        // dirt ring near pond
        float pd = length(p - uPond.xy);
        float dirt = 1.0 - smoothstep(uPond.z*0.9, uPond.z*1.7, pd);
        alb = mix(alb, uDirt * (0.9+0.2*vnoise(p*3.0)), dirt*0.85);
        // mossy rock outcrops
        float st = vnoise(p*2.0)*0.6 + vnoise(p*6.0)*0.4;
        vec3 stone = mix(vec3(0.23,0.22,0.20), vec3(0.38,0.37,0.33), st);
        stone = mix(stone, alb*0.7, smoothstep(0.65, 0.95, N.y) * 0.35); // moss on top
        float rockM = smoothstep(0.10, 0.55, vRock);
        alb = mix(alb, stone, rockM);
        // lighting: sun lambert + hemisphere
        float dif = max(dot(N, normalize(uSunDir)), 0.0);
        vec3 amb = mix(uHemiGround, uHemiSky, N.y*0.5+0.5) * uHemiInt;
        vec3 col = alb * (uSunColor * dif + amb);
        // drifting cloud shadows (ambient life)
        float cl = vnoise(p*0.045 + uTime*vec2(0.010, 0.004));
        float sh = smoothstep(0.52, 0.78, cl);
        col *= 1.0 - sh*0.38;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  scene.add(new THREE.Mesh(g, m));
}

/* ---------------- pond water (lightweight stylized) ---------------- */
let waterUniforms;
{
  const wg = new THREE.CircleGeometry(POND.r, 48);
  wg.rotateX(-Math.PI/2);
  waterUniforms = {
    uTime:{value:0},
    uDeep:{value:new THREE.Color(S.water.deep)},
    uShallow:{value:new THREE.Color(S.water.shallow)},
    uSkyCol:{value:new THREE.Color(S.water.sky)},
    uSunDir:{value:sunDir},
    uSunColor:{value:new THREE.Color(S.sky.sun)},
  };
  const wm = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    transparent: true,
    vertexShader: `
      uniform float uTime;
      varying vec3 vWp; varying vec2 vC;
      float waveH(vec2 p){
        return sin(p.x*1.4+uTime*1.3)*0.045 + sin(p.y*1.8-uTime*0.9)*0.04
             + sin((p.x+p.y)*2.6+uTime*1.8)*0.025
             + sin(p.x*7.0+uTime*3.0)*sin(p.y*6.0-uTime*2.2)*0.012; }
      void main(){
        vC = uv - 0.5;
        vec3 tp = position; tp.y += waveH(position.xz);
        vec4 wp = modelMatrix * vec4(tp, 1.0);
        vWp = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uDeep, uShallow, uSkyCol, uSunDir, uSunColor;
      varying vec3 vWp; varying vec2 vC;
      float waveH(vec2 p){
        return sin(p.x*1.4+uTime*1.3)*0.045 + sin(p.y*1.8-uTime*0.9)*0.04
             + sin((p.x+p.y)*2.6+uTime*1.8)*0.025
             + sin(p.x*7.0+uTime*3.0)*sin(p.y*6.0-uTime*2.2)*0.012; }
      void main(){
        vec2 p = vWp.xz; float e = 0.12;
        float hC = waveH(p);
        float hX = waveH(p+vec2(e,0.)) - hC;
        float hZ = waveH(p+vec2(0.,e)) - hC;
        vec3 n = normalize(vec3(-hX/e, 1.0, -hZ/e));
        float r = length(vC)*2.0;
        float depth = smoothstep(1.0, 0.25, r);
        vec3 col = mix(uShallow, uDeep, depth);
        vec3 V = normalize(cameraPosition - vWp);
        float fres = pow(1.0 - max(dot(V, n), 0.0), 3.0);
        col = mix(col, uSkyCol, fres*0.6);
        vec3 H = normalize(V + normalize(uSunDir));
        col += uSunColor * pow(max(dot(n, H), 0.0), 120.0) * 1.2;
        float foam = smoothstep(0.90, 0.995, r + 0.03*sin(uTime*1.6 + atan(vC.y, vC.x)*7.0));
        col = mix(col, vec3(0.93, 0.97, 0.95), foam*0.5);
        gl_FragColor = vec4(col, 0.94);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const water = new THREE.Mesh(wg, wm);
  water.position.set(POND.x, WATER_Y, POND.z);
  scene.add(water);
}

/* ---------------- grass: instanced blades + idle/gust wind ---------------- */
const GRASS_N = 18000, GRASS_R = 18;
let grassUniforms;
{
  const bg = new THREE.PlaneGeometry(0.14, 1.0, 1, 4);
  bg.translate(0, 0.5, 0);
  const bp = bg.attributes.position, buv = bg.attributes.uv;
  for(let i=0;i<bp.count;i++){ // taper + slight bend
    const y = buv.getY(i);
    bp.setX(i, bp.getX(i) * (1 - y*0.82));
    bp.setZ(i, bp.getZ(i) + y*y*0.22);
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:{value:0},
      uBottom:{value:new THREE.Color(S.grass.bottom)},
      uTop:{value:new THREE.Color(S.grass.top)},
      uBacklight:{value:new THREE.Color(S.grass.backlight)},
      uSunDir:{value:sunDir},
    },
    vertexShader: `
      uniform float uTime;
      varying float vH; varying vec3 vWp; varying float vTone;
      void main(){
        vH = uv.y;
        vec4 base4 = instanceMatrix * vec4(0.,0.,0.,1.);
        vec3 base = (modelMatrix * base4).xyz;
        // per-cell tone variation (deterministic)
        vTone = fract(sin(dot(floor(base.xz*3.0), vec2(12.9898,78.233)))*43758.5453);
        // idle: gentle breathing, always on — life even with no wind
        float idle = sin(uTime*1.9 + base.x*0.9 + base.z*0.7)*0.5
                   + sin(uTime*2.7 + base.z*1.3 - base.x*0.5)*0.3;
        // gust: slow traveling wave envelope across the meadow
        float gp = base.x*0.10 + base.z*0.08 - uTime*0.5;
        float gust = smoothstep(0.1, 1.0, sin(gp)*0.5+0.5);
        gust *= 0.55 + 0.45*sin(uTime*0.21 + base.x*0.04 + 1.7);
        float m = vH*vH;
        vec2 sway = vec2(idle*0.045, idle*0.02) + vec2(gust*0.30 + 0.04, gust*0.10);
        vec4 wp = modelMatrix * instanceMatrix * vec4(position,1.0);
        wp.xz += sway * m;
        wp.y -= gust * 0.05 * m;
        vWp = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      uniform vec3 uBottom,uTop,uBacklight,uSunDir;
      varying float vH; varying vec3 vWp; varying float vTone;
      void main(){
        vec3 col = mix(uBottom, uTop, smoothstep(0.05,1.0,vH));
        // tone variation: some blades yellower, some darker
        col = mix(col, col*vec3(1.15,1.08,0.75), step(0.72, vTone)*0.55);
        col *= 0.82 + 0.30*vTone;
        vec3 vdir = normalize(cameraPosition - vWp);
        float back = pow(max(dot(vdir, -normalize(uSunDir)),0.0), 3.0);
        col += uBacklight * back * vH * 0.9;
        col *= 0.75 + 0.25*vH; // fake AO at roots
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide,
  });
  grassUniforms = mat.uniforms;
  const inst = new THREE.InstancedMesh(bg, mat, GRASS_N);
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(),
        pv=new THREE.Vector3(), sv=new THREE.Vector3();
  for(let i=0;i<GRASS_N;i++){
    const r = Math.sqrt(rnd())*GRASS_R, a = rnd()*Math.PI*2;
    const x = Math.cos(a)*r, z = Math.sin(a)*r;
    const th = terrainH(x,z);
    if(th < WATER_Y + 0.06){ m.makeScale(0,0,0); m.setPosition(x,-10,z); inst.setMatrixAt(i,m); continue; }
    e.set((rnd()-0.5)*0.25, rnd()*Math.PI*2, (rnd()-0.5)*0.25); q.setFromEuler(e);
    pv.set(x, th-0.02, z);
    const sw = 0.8+rnd()*0.5;
    sv.set(sw, 0.38+rnd()*0.35, sw); // ~0.38-0.73 tall
    m.compose(pv,q,sv); inst.setMatrixAt(i,m);
  }
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

/* ---------------- wildflowers ---------------- */
const FLOWER_N = 260;
{
  const stemG = new THREE.CylinderGeometry(0.015, 0.025, 0.34, 5);
  stemG.translate(0, 0.17, 0);
  const headG = new THREE.IcosahedronGeometry(0.085, 0);
  headG.translate(0, 0.40, 0);
  const stems = new THREE.InstancedMesh(stemG,
    new THREE.MeshStandardMaterial({color:0x3e7a24, roughness:1}), FLOWER_N);
  const heads = new THREE.InstancedMesh(headG,
    new THREE.MeshStandardMaterial({roughness:0.8}), FLOWER_N);
  const cols = [0xffffff, 0xffd94a, 0xff9ec4, 0xc4a5ff, 0xff7a6b].map(c=>new THREE.Color(c));
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(),
        pv=new THREE.Vector3(), sv=new THREE.Vector3();
  for(let i=0;i<FLOWER_N;i++){
    const r = 2.5+Math.sqrt(rnd())*11.5, a=rnd()*Math.PI*2;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const th = terrainH(x,z);
    if(th < WATER_Y + 0.06){
      m.makeScale(0,0,0); m.setPosition(x,-10,z);
      stems.setMatrixAt(i,m); heads.setMatrixAt(i,m);
      heads.setColorAt(i, cols[0]); continue;
    }
    e.set((rnd()-0.5)*0.2, rnd()*Math.PI*2, (rnd()-0.5)*0.2); q.setFromEuler(e);
    const s=0.7+rnd()*0.7;
    pv.set(x, th-0.02, z); sv.set(s,s,s);
    m.compose(pv,q,sv);
    stems.setMatrixAt(i,m); heads.setMatrixAt(i,m);
    heads.setColorAt(i, cols[(rnd()*cols.length)|0]);
  }
  heads.instanceColor.needsUpdate = true;
  scene.add(stems, heads);
}

/* rocks are grown into the terrain heightfield now (see trockField) — no separate meshes */

/* ---------------- foliage: leaf puffs with flutter ---------------- */
const treeCrowns = [];
const foliageUniforms = { uTime: { value: 0 } };
// leaf puff: noise-displaced ellipsoid, vertex colors (dark core -> lit rim)
function makePuff(r, squash, seed){
  const g = new THREE.IcosahedronGeometry(r, 2);
  const p = g.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const cA = new THREE.Color(S.leaf[2]), cB = new THREE.Color(S.leaf[0]), cC = new THREE.Color(S.leaf[1]);
  const v = new THREE.Vector3();
  for(let i=0;i<p.count;i++){
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const n = vnoise2(v.x*1.3+seed, (v.y+v.z)*1.3-seed);
    const d = 1 + (n-0.5)*0.85;
    v.multiplyScalar(d); v.y *= squash;
    p.setXYZ(i, v.x, v.y, v.z);
    const t = THREE.MathUtils.clamp(v.y/(r*squash)*0.5+0.5, 0, 1);
    const cc = cA.clone().lerp(cB, t).lerp(cC, vnoise2(v.x*2.0+seed*2.0, v.z*2.0)*0.45);
    cols[i*3]=cc.r; cols[i*3+1]=cc.g; cols[i*3+2]=cc.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}
// shared puff geometry + material for instanced canopies (one draw call per tree)
const SHARED_PUFF_R = 1.0;
let sharedPuffGeo = null, sharedFoliageMat = null;
function getSharedPuff(){
  if(!sharedPuffGeo){
    sharedPuffGeo = makePuff(SHARED_PUFF_R, 0.78, 7.7);
    sharedFoliageMat = makeFoliageMat(SHARED_PUFF_R);
  }
  return { geo: sharedPuffGeo, mat: sharedFoliageMat };
}
// foliage material: standard lighting + idle flutter (moves even without wind)
function makeFoliageMat(puffR){
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = foliageUniforms.uTime;
    sh.vertexShader = ('uniform float uTime;\n#define PUFF_R ' + puffR.toFixed(3) + '\n') +
      sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 fwp = modelMatrix * vec4(transformed, 1.0);
        float ph = fwp.x*1.9 + fwp.z*2.4 + fwp.y*1.3;
        float fl = sin(uTime*2.3 + ph)*0.6 + sin(uTime*3.9 + ph*1.7)*0.4;
        float fmask = smoothstep(0.15, 0.9, length(position) / PUFF_R);
        transformed += objectNormal * fl * 0.055 * fmask;
        transformed.x += fl * 0.035 * fmask;
      }`);
  };
  return m;
}


/* ---------------- bushes: low leaf-puff clusters ---------------- */
function makeBush(x, z, s, seed){
  const g = new THREE.Group();
  const n = 4 + Math.floor(rnd()*2);
  for(let i=0;i<n;i++){
    const r = (0.45 + rnd()*0.35) * s;
    const puff = new THREE.Mesh(makePuff(r, 0.72, seed + i*3.7), makeFoliageMat(r));
    const a = (i/n)*Math.PI*2 + rnd()*0.8;
    const rr = rnd()*0.55*s;
    puff.position.set(Math.cos(a)*rr, (0.28+rnd()*0.25)*s, Math.sin(a)*rr);
    g.add(puff);
  }
  g.position.set(x, terrainH(x,z), z);
  scene.add(g); treeCrowns.push(g);
}

/* ---------------- tree: bent trunk + branches + leaf puffs ---------------- */
function makeTrunk(h, r0, r1, seed){
  const g = new THREE.CylinderGeometry(r1, r0, h, 8, 6);
  g.translate(0, h/2, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const bendA = (rnd()-0.5)*0.5, bendP = rnd()*Math.PI*2;
  for(let i=0;i<p.count;i++){
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const t = v.y / h;
    // gentle bend + root flare + bark lumps
    v.x += Math.sin(t*2.2+bendP)*bendA*t*h*0.35;
    v.z += Math.cos(t*1.7+bendP)*bendA*t*h*0.25;
    const flare = 1 + (1-t)*(1-t)*0.9;
    v.x *= flare; v.z *= flare;
    const b = 1 + (vnoise2(v.y*4+seed, Math.atan2(v.z,v.x)*2)-0.5)*0.28;
    v.x *= b; v.z *= b;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({color:S.trunk, roughness:1}));
  m.userData.topY = h;
  return m;
}
function makeTree(x, z, s, seed){
  const g = new THREE.Group();
  const barkMat = new THREE.MeshStandardMaterial({color:S.trunk, roughness:1});
  const { geo: puffGeo, mat: puffMat } = getSharedPuff();
  const branchGeos = [];
  const puffXforms = []; // {pos, scale, rotY}
  const UP = new THREE.Vector3(0,1,0);
  const tmpV = new THREE.Vector3();

  // recursive forking branch: trunk -> limbs -> branches -> twigs (+leaves)
  function branch(pos, dir, len, rad, depth){
    // tapered segment, slight natural curve via mid-offset
    const seg = new THREE.CylinderGeometry(rad*0.62, rad, len, 7, 3);
    seg.translate(0, len/2, 0);
    // bend: offset middle vertices perpendicular for organic curve
    const pp = seg.attributes.position;
    for(let i=0;i<pp.count;i++){
      const t = pp.getY(i)/len;
      const bendAmt = Math.sin(t*Math.PI) * len * 0.08;
      pp.setX(i, pp.getX(i) + bendAmt*0.6);
      pp.setZ(i, pp.getZ(i) + bendAmt*0.35);
    }
    seg.computeVertexNormals();
    // orient along dir
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
    seg.applyQuaternion(q);
    seg.translate(pos.x, pos.y, pos.z);
    branchGeos.push(seg);

    const tip = pos.clone().addScaledVector(dir, len);

    if(depth <= 0){
      // leaf tuft at twig tip (small, so branch structure shows through)
      const r = (0.42+rnd()*0.28)*s;
      puffXforms.push({
        pos: tip.clone().addScaledVector(dir, r*0.35),
        scale: r,
        rotY: rnd()*Math.PI*2,
        squash: 0.72+rnd()*0.2,
      });
      return;
    }
    // fork into children
    const nChild = depth >= 3 ? 3+Math.floor(rnd()*2) : 2+Math.floor(rnd()*2);
    const baseA = rnd()*Math.PI*2;
    for(let i=0;i<nChild;i++){
      // distribute around parent with golden-angle + jitter
      const az = baseA + i*2.39996 + (rnd()-0.5)*0.7;
      const tilt = 0.42+rnd()*0.42; // 24-48 deg from parent
      // build child dir: rotate parent dir by tilt around horizontal axis at azimuth
      const ax = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      const ndir = dir.clone().applyAxisAngle(ax, tilt);
      // upward bias (phototropism) — stronger for higher branches
      ndir.y += 0.22 + depth*0.06;
      ndir.normalize();
      // occasional downward droop for natural irregularity
      if(rnd() < 0.18) ndir.y -= 0.35;
      ndir.normalize();
      branch(tip, ndir, len*(0.60+rnd()*0.16), rad*0.60, depth-1);
    }
  }

  // trunk: slight lean, root flare handled by radius
  const lean = new THREE.Vector3((rnd()-0.5)*0.24, 1, (rnd()-0.5)*0.24).normalize();
  // start slightly below ground so base is buried
  branch(new THREE.Vector3(0,-0.25*s,0), lean, 2.7*s, 0.30*s, 3);

  // merge all branch segments into one mesh (1 draw call)
  const merged = mergeGeometries(branchGeos, false);
  branchGeos.forEach(bg => bg.dispose());
  g.add(new THREE.Mesh(merged, barkMat));

  // leaves: instanced puffs at twig tips (1 draw call)
  const inst = new THREE.InstancedMesh(puffGeo, puffMat, puffXforms.length);
  const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(),
        ee = new THREE.Euler(), vv = new THREE.Vector3(), ss = new THREE.Vector3();
  puffXforms.forEach((pf, i)=>{
    ee.set(0, pf.rotY, 0); qq.setFromEuler(ee);
    vv.copy(pf.pos); ss.set(pf.scale, pf.scale*pf.squash, pf.scale);
    m4.compose(vv, qq, ss); inst.setMatrixAt(i, m4);
  });
  inst.instanceMatrix.needsUpdate = true;
  g.add(inst);

  g.position.set(x, terrainH(x,z), z);
  g.rotation.y = rnd()*Math.PI*2;
  scene.add(g);
  treeCrowns.push(g); // whole-tree sway; leaf flutter is in-shader
}
makeTree(4.5, -3.5, 1.25, 101); makeTree(-5.5, 2.0, 1.0, 202); makeTree(1.5, -7.5, 0.85, 303);
makeTree(-9, 7, 1.1, 404); makeTree(9.5, -8, 0.9, 505);

/* ---------------- fireflies (night) ---------------- */
let flyGeo=null, flySeed=[];
if(S.fireflies){
  const N=70, pos=new Float32Array(N*3);
  for(let i=0;i<N;i++) flySeed.push({x:(rnd()-0.5)*24, y:0.6+rnd()*3.2, z:(rnd()-0.5)*24, p:rnd()*6.28});
  flyGeo=new THREE.BufferGeometry();
  flyGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  flyGeo.userData={pos};
  scene.add(new THREE.Points(flyGeo, new THREE.PointsMaterial({
    color:0xbfff9a, size:0.22, transparent:true, opacity:0.9,
    blending:THREE.AdditiveBlending, depthWrite:false })));
}

/* ---------------- camera: game vs cinema ---------------- */
const camera = new THREE.PerspectiveCamera(42, W/H, 0.1, 200);
let controls=null;
if(gameMode){
  camera.position.set(11.5, 6.8, 15.5);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(1.5, 1.0, 1.0); controls.update();
  document.getElementById('hint').textContent = `game mode · style=${styleName} · drag to orbit`;
}else{
  document.getElementById('hint').textContent = '';
}

/* ---------------- deterministic frame ---------------- */
const fadeEl=document.getElementById('fade');
const clamp01=x=>Math.min(1,Math.max(0,x));
const smooth=x=>{x=clamp01(x);return x*x*(3-2*x);};

window.renderFrame=function(t){
  grassUniforms.uTime.value = t;
  waterUniforms.uTime.value = t;
  foliageUniforms.uTime.value = t;
  if(terrainUniforms) terrainUniforms.uTime.value = t;
  if(window.__skyUniforms) window.__skyUniforms.uTime.value = t;
  // whole-tree sway: slow primary + faster secondary (subtle, always alive)
  treeCrowns.forEach((c,i)=>{
    c.rotation.z = 0.022*Math.sin(t*0.9+i*1.7) + 0.008*Math.sin(t*2.1+i*2.3);
    c.rotation.x = 0.014*Math.sin(t*0.7+i*1.1) + 0.006*Math.sin(t*1.8+i*0.7);
  });
  if(flyGeo){
    const {pos}=flyGeo.userData;
    for(let i=0;i<flySeed.length;i++){ const s=flySeed[i];
      pos[i*3]=s.x+Math.sin(t*0.7+s.p)*0.8;
      pos[i*3+1]=s.y+Math.sin(t*1.1+s.p*2)*0.35;
      pos[i*3+2]=s.z+Math.cos(t*0.5+s.p)*0.8; }
    flyGeo.attributes.position.needsUpdate=true;
  }
  if(!gameMode){
    const a = t*0.16 + 0.6;               // slow orbit
    const R = 15 - t*0.35;
    camera.position.set(Math.cos(a)*R, 6.2 - t*0.28, Math.sin(a)*R);
    camera.lookAt(0, 1.6, 0);
  } else if(controls) controls.update();
  renderer.render(scene, camera);
  fadeEl.style.opacity = gameMode ? 0 : 1 - Math.min(smooth(t/0.7), smooth((5-t)/0.7));
};
window.renderFrame(0);
window.sceneReady = true;
window.__camera = camera; window.__controls = controls; window.__scene = scene;
window.__POND = POND; window.__terrainH = terrainH; window.__WATER_Y = WATER_Y;
if(gameMode){ // live browser program: self-driven clock
  const clock = new THREE.Clock();
  (function animate(){
    requestAnimationFrame(animate);
    window.renderFrame(clock.getElapsedTime());
  })();
}
