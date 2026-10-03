import { describe, expect, test } from 'bun:test';
import { fixture } from './tours.mjs';
import { planFiles, wrapCaption, captionArgs, videoArgs, contactSheetArgs, frameTimeline, proofIndex } from './media.mjs';

describe('media.mjs planning without Chromium or ffmpeg', () => {
  const files = planFiles(fixture);
  test('one numbered PNG, raw image, caption file and failure image per step', () => {
    expect(files.map(file => file.image)).toEqual(['01.png', '02.png', '03.png', '04.png']);
    expect(files[0]).toMatchObject({ raw: 'raw/01.png', text: 'raw/01.txt', failure: '01-not-proven.png', height: 900, band: 60 });
    expect(files[3]).toMatchObject({ width: 390, height: 844 });
  });
  test('the last set-viewport action controls final image and caption dimensions', () => {
    const tour = structuredClone(fixture);
    tour.steps[0].actions.push({ type: 'set-viewport', viewport: 'mobile' });
    expect(planFiles(tour)[0].width).toBe(390);
    expect(planFiles(tour)[0].height).toBe(844);
  });
  test('caption band is below the app, using literal textfiles (no filter injection)', () => {
    const filter = captionArgs(files[0])[captionArgs(files[0]).indexOf('-vf') + 1];
    expect(filter).toContain('pad=iw:ih+60:0:0');
    expect(filter).toContain('textfile=raw/01-1.txt:expansion=none');
    expect(filter).toContain('y=916');
    expect(captionArgs(files[0], true).at(-1)).toBe('01-not-proven.png');
    const mobileFilter = captionArgs(files[3])[captionArgs(files[3]).indexOf('-vf') + 1];
    expect(mobileFilter).toContain('textfile=raw/04-2.txt');
    expect(mobileFilter).toContain('y=888');
    const wrapped = wrapCaption('Caption with quotes "hi", colon: and percent %{safe}, plus ' + 'x'.repeat(80), 390);
    expect(wrapped.split('\n').every(line => line.length <= 27)).toBe(true);
    expect(wrapped).toContain('%{safe}');
  });
  test('inline-compatible video uses CDP frames, H.264, yuv420p and faststart with a fixed even canvas', () => {
    const args = videoArgs();
    expect(args).toContain('raw/frames.ffconcat');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args).toContain('+faststart');
    expect(args[args.indexOf('-vf') + 1]).toContain('pad=1440:900');
  });
  test('contact sheet includes all captioned images, including a single-step tour', () => {
    const args = contactSheetArgs(files);
    for (const file of files) expect(args).toContain(file.image);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('layout=0_0|720_0|0_520|720_520');
    expect(contactSheetArgs(files.slice(0, 1))).toContain('[0:v]scale=720:520:force_original_aspect_ratio=decrease,pad=720:520:(ow-iw)/2:(oh-ih)/2:color=0x202535[s0];[s0]null[out]');
  });
  test('screencast intervals and final static hold survive encoding; unsafe frames fail', () => {
    const frames = [{ file: 'frames/000001.jpg', timestamp: 1 }, { file: 'frames/000002.jpg', timestamp: 3 }];
    expect(frameTimeline(frames, 5).content).toBe("ffconcat version 1.0\nfile 'frames/000001.jpg'\nduration 2.000000\nfile 'frames/000002.jpg'\nduration 2.000000\nfile 'frames/000002.jpg'\n");
    expect(() => frameTimeline([], 1)).toThrow('No screencast');
    expect(() => frameTimeline([{ file: '../escape', timestamp: 1 }], 3)).toThrow('Invalid screencast');
    expect(() => frameTimeline(frames, 2)).toThrow('Invalid screencast timing');
  });
  test('drops the real backward CDP timestamp without rewinding or shortening static holds', () => {
    const frames = [
      { file: 'frames/000030.jpg', timestamp: 1791020378.059534 },
      { file: 'frames/000031.jpg', timestamp: 1791020379.059534 },
      { file: 'frames/000032.jpg', timestamp: 1791020379.052211 },
      { file: 'frames/000033.jpg', timestamp: 1791020380.059534 },
    ];
    const timeline = frameTimeline(frames, 1791020382.059534);
    expect(timeline.droppedFrames).toBe(1);
    expect(timeline.content).not.toContain('000032.jpg');
    expect(timeline.content.match(/duration [0-9.]+/g)).toEqual(['duration 1.000000', 'duration 1.000000', 'duration 2.000000']);
    expect(frameTimeline(frames.slice(0, 3), 1791020382.059534).content).toContain('duration 3.000000');
    expect(frameTimeline([{ file: 'frames/1.jpg', timestamp: 1 }, { file: 'frames/2.jpg', timestamp: 1 }], 2).droppedFrames).toBe(0);
    expect(() => frameTimeline([...frames, { file: '../escape', timestamp: 0 }], 1791020382.059534)).toThrow('Invalid screencast frame');
    expect(() => frameTimeline([{ file: 'frames/1.jpg', timestamp: NaN }], 2)).toThrow('Invalid screencast frame');
  });
  test('index names every caption and artifact', () => {
    const index = proofIndex(fixture, files);
    expect(index).toContain('[Video](video.mp4)');
    expect(index).toContain('![Contact sheet](contact-sheet.png)');
    fixture.steps.forEach((step, i) => { expect(index).toContain(step.caption); expect(index).toContain('(' + files[i].image + ')'); });
  });
});
