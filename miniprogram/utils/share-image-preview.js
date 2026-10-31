function isDevtools(wx) {
  try { return (wx.getDeviceInfo?.().platform || wx.getSystemInfoSync?.().platform) === 'devtools'; }
  catch { return false; }
}
async function previewExportedImage(wx, path, current = () => true) {
  if (!current()) return;
  let source = path;
  if (isDevtools(wx)) {
    // The simulator's native sharing sheet may not resolve a canvas temp-file URL.
    // Read the actual export in memory; never guess or rewrite a localhost port.
    const bytes = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
      filePath: path, success: result => resolve(result.data), fail: reject,
    }));
    if (!current()) return;
    const data = new Uint8Array(bytes);
    if (data.length < 24 || ![137,80,78,71,13,10,26,10].every((value,index) => data[index] === value))
      throw new Error('导出图片不可用，请重新生成');
    source = 'data:image/png;base64,' + wx.arrayBufferToBase64(bytes);
  }
  if (!current()) return;
  return new Promise((resolve, reject) => wx.previewImage({ current: source, urls: [source], success: resolve, fail: reject }));
}
module.exports = { isDevtools, previewExportedImage };
