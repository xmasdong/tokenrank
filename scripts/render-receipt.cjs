// Render the same production Canvas code from a local, aggregate-only usage snapshot.
// CANVAS_MODULE=/path/@napi-rs/canvas node scripts/render-receipt.cjs snapshot.json output-dir
const { createCanvas, loadImage, GlobalFonts } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
const fs = require('node:fs'), path = require('node:path');
const { drawReceiptPoster, RECEIPT_HEIGHT } = require('../miniprogram/utils/receipt-poster');
async function main() {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error('Usage: render-receipt.cjs snapshot.json output-dir');
  if (process.env.SANS_FONT) GlobalFonts.registerFromPath(process.env.SANS_FONT,'PingFang SC');
  if (process.env.EMOJI_FONT) GlobalFonts.registerFromPath(process.env.EMOJI_FONT,'Apple Color Emoji');
  const snapshot = JSON.parse(fs.readFileSync(source,'utf8'));
  const codeImage = await loadImage(path.resolve(__dirname,'../miniprogram/assets/mini-program-code.jpg'));
  fs.mkdirSync(output,{recursive:true});
  for (const theme of ['paper','ink']) for (const cover of [false,true]) {
    const canvas = createCanvas(1000,cover?800:RECEIPT_HEIGHT);
    drawReceiptPoster(canvas.getContext('2d'),{...snapshot,theme,cover,codeImage});
    const file=path.resolve(output,`receipt-${theme}${cover?'-cover':''}.png`);
    fs.writeFileSync(file,canvas.toBuffer('image/png'));console.log(file);
  }
}
main().catch(err=>{console.error(err.message);process.exitCode=1});
