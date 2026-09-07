/* 昵称派生出的纯文字头像：不读取相册、不上传文件，跨页面保持稳定配色。 */
const TONES = ['avatar-tone-0', 'avatar-tone-1', 'avatar-tone-2', 'avatar-tone-3', 'avatar-tone-4'];

function hashText(value) {
  let hash = 0;
  for (const character of Array.from(String(value || ''))) {
    hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  }
  return hash;
}

function buildTextAvatar(nickname) {
  const cleanName = String(nickname || '').trim();
  const label = Array.from(cleanName).slice(0, 2).join('') || '生';
  return { label, tone: TONES[hashText(cleanName || label) % TONES.length] };
}

module.exports = { buildTextAvatar };
