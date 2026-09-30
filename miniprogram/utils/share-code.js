// All generated images use the user-provided, bundled mini-program code.
// Personal record navigation belongs to the native share card's path.
const CODE_PATH = '/assets/mini-program-code.jpg';

function getCodePath() {
  return Promise.resolve(CODE_PATH);
}

function loadCodeImage(canvas) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('小程序码加载失败，请重试'));
    };
    const timer = setTimeout(fail, 10000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = fail;
    img.src = CODE_PATH;
  });
}
function drawCodeBadge(ctx, image, x, y, size) {
  // Keep the source untouched. The inset also preserves the off-centre WeChat mark.
  const inset = size * 0.06;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x, y, size, size);
  if (image) ctx.drawImage(image, x + inset, y + inset, size - inset * 2, size - inset * 2);
  ctx.restore();
}
module.exports = { CODE_PATH, getCodePath, loadCodeImage, drawCodeBadge };
