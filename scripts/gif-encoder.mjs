const pushWord = (target, value) => {
  target.push(value & 0xff, (value >> 8) & 0xff);
};

const rgb332Palette = () => {
  const palette = [];
  for (let index = 0; index < 256; index += 1) {
    palette.push(((index >> 5) & 7) * 36, ((index >> 2) & 7) * 36, (index & 3) * 85);
  }
  return palette;
};

const indexedPixels = (pixels) => {
  const indexed = new Uint8Array(pixels.length / 4);
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    indexed[target] = (pixels[source] & 0xe0) | ((pixels[source + 1] & 0xe0) >> 3) | ((pixels[source + 2] & 0xc0) >> 6);
  }
  return indexed;
};

const lzw = (pixels) => {
  const clear = 256;
  const end = 257;
  let codeSize = 9;
  let nextCode = 258;
  let dictionary = new Map();
  const bytes = [];
  let buffer = 0;
  let bitCount = 0;
  const emit = (code) => {
    buffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(buffer & 0xff);
      buffer >>= 8;
      bitCount -= 8;
    }
  };
  const reset = () => {
    dictionary = new Map();
    codeSize = 9;
    nextCode = 258;
  };

  emit(clear);
  if (!pixels.length) {
    emit(end);
    return bytes;
  }
  let current = String(pixels[0]);
  for (let index = 1; index < pixels.length; index += 1) {
    const next = pixels[index];
    const pair = `${current},${next}`;
    const code = dictionary.get(pair);
    if (code !== undefined) {
      current = pair;
      continue;
    }
    emit(dictionary.has(current) ? dictionary.get(current) : Number(current));
    if (nextCode < 4096) {
      dictionary.set(pair, nextCode);
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      emit(clear);
      reset();
    }
    current = String(next);
  }
  emit(dictionary.has(current) ? dictionary.get(current) : Number(current));
  emit(end);
  if (bitCount) bytes.push(buffer & 0xff);
  return bytes;
};

const appendSubBlocks = (target, bytes) => {
  for (let index = 0; index < bytes.length; index += 255) {
    const block = bytes.slice(index, index + 255);
    target.push(block.length, ...block);
  }
  target.push(0);
};

export const encodeGif = ({ width, height, frames, delayCentiseconds = 70 }) => {
  const bytes = [...Buffer.from('GIF89a', 'ascii')];
  pushWord(bytes, width);
  pushWord(bytes, height);
  bytes.push(0xf7, 0, 0, ...rgb332Palette());
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00);

  frames.forEach((frame) => {
    if (frame.width !== width || frame.height !== height) throw new Error('All GIF frames must have the same dimensions.');
    bytes.push(0x21, 0xf9, 0x04, 0x04);
    pushWord(bytes, delayCentiseconds);
    bytes.push(0, 0);
    bytes.push(0x2c);
    pushWord(bytes, 0);
    pushWord(bytes, 0);
    pushWord(bytes, width);
    pushWord(bytes, height);
    bytes.push(0x00, 8);
    appendSubBlocks(bytes, lzw(indexedPixels(frame.pixels)));
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
};
