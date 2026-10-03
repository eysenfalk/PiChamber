import { VIEWPORTS, validateTour } from './tours.mjs';

export function wrapCaption(caption, width) {
  // Conservative character budget for 20px proportional text, including mobile.
  const limit = Math.floor((width - 32) / 13);
  const words = caption.trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    for (let offset = 0; offset < word.length; offset += limit) {
      const part = word.slice(offset, offset + limit);
      if (line && line.length + part.length + 1 > limit) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + part;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

export function planFiles(tour) {
  validateTour(tour);
  return tour.steps.map((step, index) => {
    const number = String(index + 1).padStart(2, '0');
    const viewport = VIEWPORTS[step.actions.findLast(action => action.type === 'set-viewport')?.viewport ?? step.viewport];
    const caption = wrapCaption(step.caption, viewport.width);
    return { number, image: number + '.png', raw: 'raw/' + number + '.png', text: 'raw/' + number + '.txt',
      failure: number + '-not-proven.png', caption, width: viewport.width, height: viewport.height,
      band: caption.split('\n').length * 28 + 32 };
  });
}

const ffmpegBase = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '1'];
export function captionArgs(file, failed = false) {
  // Generated filenames only: captions use textfile + expansion=none, never filter interpolation.
  const text = file.caption.split('\n').map((_, index) => 'drawtext=textfile=' + file.text.replace('.txt', '-' + (index + 1) + '.txt') +
    ':expansion=none:font=DejaVu Sans:fontcolor=white:fontsize=20:x=16:y=' + (file.height + 16 + index * 28));
  const filter = ['pad=iw:ih+' + file.band + ':0:0:color=0x202535', ...text].join(',');
  return [...ffmpegBase, '-i', file.raw, '-vf', filter, '-frames:v', '1', failed ? file.failure : file.image];
}

export function videoArgs() {
  return [...ffmpegBase, '-f', 'concat', '-safe', '1', '-i', 'raw/frames.ffconcat', '-vf',
    'scale=1440:900:force_original_aspect_ratio=decrease:in_range=pc:out_range=tv,pad=1440:900:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', 'video.mp4'];
}

export function contactSheetArgs(files) {
  const columns = Math.min(2, files.length);
  const filters = files.map((file, index) => '[' + index + ':v]scale=720:520:force_original_aspect_ratio=decrease,pad=720:520:(ow-iw)/2:(oh-ih)/2:color=0x202535[s' + index + ']');
  const positions = files.map((_, index) => (index % columns) * 720 + '_' + Math.floor(index / columns) * 520);
  if (files.length === 1) filters.push('[s0]null[out]');
  else filters.push(files.map((_, index) => '[s' + index + ']').join('') + 'xstack=inputs=' + files.length + ':layout=' + positions.join('|') + ':fill=0x202535[out]');
  return [...ffmpegBase, '-filter_complex_threads', '1', ...files.flatMap(file => ['-i', file.image]), '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', 'contact-sheet.png'];
}

/** CDP ScreencastFrameMetadata timestamps are seconds since epoch. Preserve static holds. */
export function frameTimeline(frames, endedAt) {
  if (!frames.length) throw new Error('No screencast frames captured');
  const lines = ['ffconcat version 1.0'];
  frames.forEach((frame, index) => {
    if (!(frame.file.startsWith('frames/') && /^[0-9]+\.jpg$/.test(frame.file.slice(7))) || !Number.isFinite(frame.timestamp)) throw new Error('Invalid screencast frame');
    const end = frames[index + 1]?.timestamp ?? endedAt;
    if (!Number.isFinite(end) || end < frame.timestamp) throw new Error('Invalid screencast timing at frame ' + (index + 1) + ': ' + frame.timestamp + ' -> ' + end);
    lines.push("file '" + frame.file + "'", 'duration ' + Math.max(1 / 30, end - frame.timestamp).toFixed(6));
  });
  lines.push("file '" + frames.at(-1).file + "'");
  return lines.join('\n') + '\n';
}

export const markdownEscape = text => text.replace(/[\[\]\\]/g, '\\$&').replace(/\s+/g, ' ');
export function proofIndex(tour, files) {
  return '# Proof: ' + tour.name + '\n\n[Video](video.mp4)\n\n![Contact sheet](contact-sheet.png)\n\n' +
    tour.steps.map((step, index) => (index + 1) + '. ' + step.caption + '\n\n   ![' + markdownEscape(step.caption) + '](' + files[index].image + ')\n').join('\n');
}
