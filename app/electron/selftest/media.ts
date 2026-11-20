// selftest group: media. YouTube fullscreen and audio indicator (network, plays real video).
import { pageRects } from '../../shared/layout';
import type { Group } from './kit';

export const media: Group = {
  name: 'media',
  desc: "YouTube fullscreen and audio indicator (network, plays real video)",
  needs: ['tabs'],
  slow: true,
  async run(t) {
    const { ctx, tabs, runtime, result, info, ui, dispatch, tab, bounds, composite, sleep, waitFor, rectEq, fmt } = t;
  // ---- 9. HTML fullscreen (YouTube) ----
  await dispatch({ type: 'focusTab', tabId: 'tab_t2' });
  const yt = tabs.webContentsOf('tab_t2')!;
  await waitFor(() => yt.executeJavaScript(`!!document.querySelector('#movie_player, video')`), 15000);
  const enterFs = () =>
    yt.executeJavaScript(`(document.querySelector('#movie_player') || document.querySelector('video') || document.documentElement).requestFullscreen().then(() => 'ok', e => String(e))`, true);
  const r1 = await enterFs();
  const fsOn = await waitFor(() => runtime.fullscreenTabId === 'tab_t2' && ctx.win().isFullScreen(), 6000);
  await sleep(800);
  const cb = ctx.win().getContentBounds();
  result(fsOn && rectEq(bounds('tab_t2'), { x: 0, y: 0, width: cb.width, height: cb.height }), 'YouTube fullscreen: page fills the window', `${r1}, page ${fmt(bounds('tab_t2'))}`);
  await composite('08-fullscreen');
  await yt.executeJavaScript('document.exitFullscreen()', true);
  const fsOff = await waitFor(() => runtime.fullscreenTabId === null && !ctx.win().isFullScreen(), 6000);
  await sleep(600);
  result(fsOff && rectEq(bounds('tab_t2'), pageRects(ctx.layoutInput()).primary), 'exit fullscreen restores chrome', `page ${fmt(bounds('tab_t2'))}`);
  await enterFs();
  await waitFor(() => runtime.fullscreenTabId === 'tab_t2', 6000);
  await sleep(500);
  yt.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  result(await waitFor(() => runtime.fullscreenTabId === null && !ctx.win().isFullScreen(), 6000), 'Esc exits fullscreen');
  await sleep(500);

  // ---- 10. audio indicator ----
  await yt.executeJavaScript(`(() => { const v = document.querySelector('video'); if (v) { v.muted = false; return v.play().then(() => 'playing', e => String(e)); } return 'no video'; })()`, true);
  const audible = await waitFor(() => runtime.tabs.tab_t2?.audible === true, 8000);
  info('audio', audible ? 'tab_t2 reported audible (speaker icon shows)' : 'no audible event (autoplay may be blocked)');
  if (audible) {
    await ui(`window.jivvy.setMuted('tab_t2', true)`);
    result(await waitFor(() => runtime.tabs.tab_t2?.muted === true && yt.isAudioMuted(), 2000), 'mute tab');
    await ui(`window.jivvy.setMuted('tab_t2', false)`);
  }
  },
};
