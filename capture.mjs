import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';

const style = process.argv[2] || 'summer';
const out = process.argv[3] || `scene-engine-${style}-5s.mp4`;
const FRAMES = 150, DUR = 5, PORT = 8126;
const shots = '/tmp/scene-engine-frames';
fs.rmSync(shots, {recursive:true, force:true}); fs.mkdirSync(shots,{recursive:true});

const browser = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1280,height:720}});
page.on('console', m=>{ if(m.type()==='error') console.log('[console]', m.text().slice(0,120)); });
page.on('pageerror', e=>console.log('[pageerror]', String(e).slice(0,120)));
await page.goto(`http://localhost:${PORT}/?style=${style}`, {waitUntil:'networkidle'});
await page.waitForFunction('window.sceneReady===true', null, {timeout:30000});
await new Promise(r=>setTimeout(r,500));
for(let i=0;i<FRAMES;i++){
  const t = i/(FRAMES-1)*DUR;
  await page.evaluate(t=>window.renderFrame(t), t);
  await page.screenshot({path:`${shots}/f${String(i).padStart(4,'0')}.png`});
  if(i%50===0) console.log('frame',i);
}
await browser.close();
execSync(`ffmpeg -y -loglevel error -framerate 30 -i ${shots}/f%04d.png -c:v libx264 -pix_fmt yuv420p ${out}`);
console.log('wrote', out);
