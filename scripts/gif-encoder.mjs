import gifenc from 'gifenc';

const { GIFEncoder, applyPalette, quantize } = gifenc;

export const encodeGif = ({ width, height, frames, delayCentiseconds = 70 }) => {
  const gif = GIFEncoder();
  frames.forEach((frame, index) => {
    if (frame.width !== width || frame.height !== height) throw new Error('All GIF frames must have the same dimensions.');
    const palette = quantize(frame.pixels, 256, { format: 'rgb565' });
    const indexed = applyPalette(frame.pixels, palette, 'rgb565');
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: delayCentiseconds * 10,
      repeat: index === 0 ? 0 : undefined,
      dispose: 1,
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
};
