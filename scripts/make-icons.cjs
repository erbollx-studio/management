/**
 * One-off PWA icon generator. No raster image libraries are installed, so we
 * render an SVG monogram in headless Chromium (Playwright) and screenshot it
 * at each required size. Run: node scripts/make-icons.cjs
 */
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const OUT = path.join(__dirname, '..', 'public', 'icons')

const INK = '#3A3F52'
const IVORY = '#F7F5F0'

/**
 * @param {number} size viewport / output pixel size
 * @param {boolean} maskable full-bleed background (OS applies its own mask);
 *   non-maskable icons get a rounded square on a transparent canvas
 */
function svg(size, maskable) {
  // Maskable safe zone is the inner 80% — keep the glyph well inside it.
  const fontSize = maskable ? size * 0.5 : size * 0.58
  const radius = maskable ? 0 : size * 0.22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${INK}"/>
  <text x="50%" y="54%" dominant-baseline="central" text-anchor="middle"
    font-family="'Source Serif 4','Iowan Old Style',Palatino,Georgia,'Times New Roman',serif"
    font-weight="600" font-size="${fontSize}" fill="${IVORY}">M</text>
</svg>`
}

const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'maskable-512.png', size: 512, maskable: true },
  // iOS composites its own corner mask, so apple-touch-icon is full bleed.
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
]

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  })
  try {
    for (const { file, size, maskable } of ICONS) {
      const page = await browser.newPage({ viewport: { width: size, height: size } })
      const html = `<!doctype html><body style="margin:0">${svg(size, maskable)}</body>`
      await page.goto('data:text/html,' + encodeURIComponent(html))
      await page.screenshot({
        path: path.join(OUT, file),
        // Transparent corners for the rounded non-maskable icons.
        omitBackground: !maskable,
      })
      await page.close()
      console.log('wrote', file)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
