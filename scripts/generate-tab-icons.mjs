import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const root = new URL('../miniprogram/', import.meta.url);
const { tabBar } = JSON.parse(await readFile(new URL('app.json', root), 'utf8'));
for (const name of ['home', 'students', 'manage']) {
  const svg = await readFile(new URL(`assets/tabbar/${name}.svg`, root), 'utf8');
  for (const [suffix, color] of [['', tabBar.color], ['-selected', tabBar.selectedColor]]) {
    await sharp(Buffer.from(svg.replaceAll('currentColor', color)), { density: 288 })
      .resize(81, 81).png().toFile(new URL(`assets/tabbar/${name}${suffix}.png`, root).pathname);
  }
}
