const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_INPUT_BYTES = 80 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function supportedImage(bytes) {
  return (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
}

function createAvatarStore(dir) {
  const pending = new Map();
  const fileFor = (owner) => path.join(dir, crypto.createHash('sha256').update(owner).digest('hex') + '.jpg');

  function run(owner, task) {
    const current = (pending.get(owner) || Promise.resolve()).catch(() => {}).then(task);
    pending.set(owner, current);
    return current.finally(() => {
      if (pending.get(owner) === current) pending.delete(owner);
    });
  }

  async function read(owner) {
    try {
      const bytes = await fs.readFile(fileFor(owner));
      return { bytes, version: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
  }

  async function normalize(image) {
    if (typeof image !== 'string' || image.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(image) || image.length % 4 !== 0) return null;
    const bytes = Buffer.from(image, 'base64');
    if (bytes.length > MAX_INPUT_BYTES || !supportedImage(bytes)) return null;
    const sharp = require('sharp');
    try {
      const input = sharp(bytes, { limitInputPixels: 4_000_000, failOn: 'warning' });
      const meta = await input.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format) || meta.pages > 1) return null;
      return await input.rotate().resize(256, 256, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    } catch (error) {
      return null;
    }
  }

  async function write(owner, bytes) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const final = fileFor(owner);
    const temporary = final + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, final);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  return { run, read, normalize, write, remove: (owner) => fs.rm(fileFor(owner), { force: true }) };
}

module.exports = { createAvatarStore };
